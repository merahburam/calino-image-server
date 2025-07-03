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