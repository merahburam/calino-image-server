const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support large base64 images

app.use('/images', express.static(path.join(__dirname, 'public/images')));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initializeDatabase() {
  try {
    const client = await pool.connect();
    
    // Create user_history table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_history (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        item_id VARCHAR(255) NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        image_url TEXT,
        original_image_url TEXT,
        frame_id VARCHAR(255),
        frame_name VARCHAR(255),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        quality VARCHAR(50),
        width INTEGER,
        height INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create license_usage table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_usage (
        id SERIAL PRIMARY KEY,
        license_key VARCHAR(255) UNIQUE NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        product_id VARCHAR(255) NOT NULL,
        product_tier VARCHAR(50) NOT NULL,
        flowers_granted INTEGER NOT NULL,
        activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        gumroad_data JSONB,
        status VARCHAR(20) DEFAULT 'active'
      )
    `);
    
    // Create indexes for better performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_history_user_id ON user_history(user_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_history_timestamp ON user_history(timestamp DESC)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_history_item_id ON user_history(item_id)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_license_usage_key ON license_usage(license_key)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_license_usage_user ON license_usage(user_id)
    `);
    
    client.release();
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({ 
    message: 'Calino Image Server with PostgreSQL', 
    status: 'running',
    database: 'connected',
    endpoints: {
      images: '/images/calino/',
      history: '/api/history/:userId'
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    
    res.json({ 
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// Get user history with pagination and search
app.get('/api/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 0, limit = 10, search = '' } = req.query;
    
    const client = await pool.connect();
    
    let query = `
      SELECT item_id, prompt, image_url, original_image_url, frame_id, frame_name, 
             timestamp, quality, width, height
      FROM user_history 
      WHERE user_id = $1
    `;
    let queryParams = [userId];
    
    // Add search filter if provided
    if (search && search.trim()) {
      query += ` AND prompt ILIKE $2`;
      queryParams.push(`%${search.trim()}%`);
    }
    
    // Add ordering and pagination
    query += ` ORDER BY timestamp DESC`;
    
    if (limit && limit !== 'all') {
      const limitNum = parseInt(limit);
      const offsetNum = parseInt(page) * limitNum;
      query += ` LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
      queryParams.push(limitNum, offsetNum);
    }
    
    const result = await client.query(query, queryParams);
    
    // Debug logging to see what's being retrieved
    console.log(`History query for user ${userId}:`, {
      search: search?.trim() || 'none',
      page: page,
      limit: limit,
      resultCount: result.rows.length,
      sampleIds: result.rows.slice(0, 3).map(r => ({ id: r.item_id, hasImage: !!r.image_url, timestamp: r.timestamp }))
    });
    
    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) FROM user_history WHERE user_id = $1`;
    let countParams = [userId];
    
    if (search && search.trim()) {
      countQuery += ` AND prompt ILIKE $2`;
      countParams.push(`%${search.trim()}%`);
    }
    
    const countResult = await client.query(countQuery, countParams);
    const totalItems = parseInt(countResult.rows[0].count);
    
    client.release();
    
    // Format response to match expected structure
    const items = result.rows.map(row => ({
      id: row.item_id,
      prompt: row.prompt,
      imageUrl: row.image_url,
      originalImageUrl: row.original_image_url,
      frameId: row.frame_id,
      frameName: row.frame_name,
      timestamp: row.timestamp,
      quality: row.quality,
      dimensions: {
        width: row.width,
        height: row.height
      }
    }));
    
    const limitNum = limit === 'all' ? totalItems : parseInt(limit);
    const totalPages = Math.ceil(totalItems / limitNum);
    
    res.json({
      items,
      totalPages,
      currentPage: parseInt(page),
      totalItems
    });
    
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Save history item
app.post('/api/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const historyItem = req.body;
    
    const client = await pool.connect();
    
    // Insert new history item
    const query = `
      INSERT INTO user_history (
        user_id, item_id, prompt, image_url, original_image_url, 
        frame_id, frame_name, quality, width, height, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (item_id) DO UPDATE SET
        prompt = EXCLUDED.prompt,
        image_url = EXCLUDED.image_url,
        original_image_url = EXCLUDED.original_image_url,
        timestamp = EXCLUDED.timestamp
    `;
    
    // Convert ISO string timestamp to Date object
    const timestamp = historyItem.timestamp ? new Date(historyItem.timestamp) : new Date();
    
    await client.query(query, [
      userId,
      historyItem.id,
      historyItem.prompt,
      historyItem.imageUrl,
      historyItem.originalImageUrl,
      historyItem.frameId,
      historyItem.frameName,
      historyItem.quality,
      historyItem.dimensions?.width,
      historyItem.dimensions?.height,
      timestamp
    ]);
    
    // Get total count for this user
    const countResult = await client.query(
      'SELECT COUNT(*) FROM user_history WHERE user_id = $1',
      [userId]
    );
    
    // Implement rolling limit - keep only the most recent 50 per user
    await client.query(`
      DELETE FROM user_history 
      WHERE user_id = $1 
      AND id NOT IN (
        SELECT id FROM user_history 
        WHERE user_id = $2 
        ORDER BY timestamp DESC 
        LIMIT 50
      )
    `, [userId, userId]);
    
    client.release();
    
    res.json({ 
      success: true, 
      totalItems: parseInt(countResult.rows[0].count)
    });
    
  } catch (error) {
    console.error('Error saving history:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail
    });
    res.status(500).json({ 
      error: 'Failed to save history',
      details: error.message 
    });
  }
});

// Update frame ID for a specific history item
app.post('/api/history/:userId/update-frame', async (req, res) => {
  try {
    const { userId } = req.params;
    const { itemId, frameId } = req.body;
    
    if (!itemId || !frameId) {
      return res.status(400).json({ error: 'itemId and frameId are required' });
    }
    
    const client = await pool.connect();
    
    const query = `
      UPDATE user_history 
      SET frame_id = $1 
      WHERE user_id = $2 AND item_id = $3
    `;
    
    const result = await client.query(query, [frameId, userId, itemId]);
    
    client.release();
    
    if (result.rowCount > 0) {
      res.json({ 
        success: true, 
        message: `Updated frameId for item ${itemId}`,
        updatedRows: result.rowCount
      });
    } else {
      res.status(404).json({ 
        success: false, 
        message: `No history item found with id ${itemId} for user ${userId}` 
      });
    }
    
  } catch (error) {
    console.error('Error updating frame ID:', error);
    res.status(500).json({ 
      error: 'Failed to update frame ID',
      details: error.message 
    });
  }
});

// Test endpoint for license verification
app.get('/api/verify-license', (req, res) => {
  res.json({ 
    message: 'License verification endpoint is working',
    method: 'POST',
    expectedBody: {
      productId: 'string',
      licenseKey: 'string'
    }
  });
});

// Verify Gumroad license endpoint with database tracking
app.post('/api/verify-license', async (req, res) => {
  try {
    const { productId, licenseKey, userId } = req.body;
    
    if (!productId || !licenseKey || !userId) {
      return res.status(400).json({ error: 'productId, licenseKey, and userId are required' });
    }
    
    const client = await pool.connect();
    
    try {
      // First, check if this license key has already been used
      const existingLicense = await client.query(
        'SELECT * FROM license_usage WHERE license_key = $1',
        [licenseKey]
      );
      
      if (existingLicense.rows.length > 0) {
        const usage = existingLicense.rows[0];
        client.release();
        return res.json({
          success: false,
          message: `This license key has already been activated on ${usage.activated_at.toLocaleDateString()} by user ${usage.user_id}. Each license can only be used once.`,
          alreadyUsed: true
        });
      }
      
      // Use environment variable for Gumroad access token
      const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN;
      
      if (!GUMROAD_ACCESS_TOKEN) {
        client.release();
        return res.status(500).json({ error: 'Gumroad access token not configured' });
      }
      
      // Verify with Gumroad API
      const formData = new URLSearchParams();
      formData.append('access_token', GUMROAD_ACCESS_TOKEN);
      formData.append('product_id', productId);
      formData.append('license_key', licenseKey);
      formData.append('increment_uses_count', 'false');
      
      const response = await fetch('https://api.gumroad.com/v2/licenses/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        // Determine product tier and flowers based on productId
        const productTierMap = {
          '2FqGqjM16Jjs0NDRtncN4g==': { tier: 'starter', flowers: 50 },
          'wIY3NX2VLnJ48nTz0ZVTIA==': { tier: 'creator', flowers: 130 },
          '711rWT3AqbdSnNL0p9MxIw==': { tier: 'pro', flowers: 300 }
        };
        
        const productInfo = productTierMap[productId] || { tier: 'unknown', flowers: 0 };
        
        // Save the license usage to our database
        await client.query(`
          INSERT INTO license_usage (
            license_key, user_id, product_id, product_tier, flowers_granted, gumroad_data
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          licenseKey,
          userId,
          productId,
          productInfo.tier,
          productInfo.flowers,
          JSON.stringify(data.purchase)
        ]);
        
        client.release();
        
        // Return successful verification with our tier info
        res.json({
          success: true,
          purchase: data.purchase,
          tier: productInfo.tier,
          flowers: productInfo.flowers,
          tokensGranted: productInfo.flowers // For backward compatibility
        });
      } else {
        client.release();
        res.json({
          success: false,
          message: data.message || 'License verification failed with Gumroad'
        });
      }
      
    } catch (dbError) {
      client.release();
      throw dbError;
    }
    
  } catch (error) {
    console.error('License verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during license verification'
    });
  }
});

// Admin endpoint to view license usage
app.get('/api/admin/licenses', async (req, res) => {
  try {
    const { page = 0, limit = 50 } = req.query;
    
    const client = await pool.connect();
    
    const offset = parseInt(page) * parseInt(limit);
    
    // Get license usage with pagination
    const result = await client.query(`
      SELECT 
        license_key,
        user_id,
        product_tier,
        flowers_granted,
        activated_at,
        status,
        gumroad_data->>'product_name' as product_name,
        gumroad_data->>'email' as email
      FROM license_usage 
      ORDER BY activated_at DESC 
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);
    
    // Get total count
    const countResult = await client.query('SELECT COUNT(*) FROM license_usage');
    const totalItems = parseInt(countResult.rows[0].count);
    
    client.release();
    
    res.json({
      licenses: result.rows,
      totalItems,
      totalPages: Math.ceil(totalItems / parseInt(limit)),
      currentPage: parseInt(page)
    });
    
  } catch (error) {
    console.error('Error getting license usage:', error);
    res.status(500).json({
      error: 'Failed to get license usage'
    });
  }
});

// Test database connection endpoint
app.get('/api/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as postgres_version');
    client.release();
    
    res.json({
      connected: true,
      current_time: result.rows[0].current_time,
      postgres_version: result.rows[0].postgres_version
    });
  } catch (error) {
    res.status(500).json({
      connected: false,
      error: error.message
    });
  }
});

// Initialize database and start server
async function startServer() {
  try {
    await initializeDatabase();
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();