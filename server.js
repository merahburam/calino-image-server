const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support large base64 images

app.use('/images', express.static(path.join(__dirname, 'public/images')));

app.get('/', (req, res) => {
  res.json({ 
    message: 'Calino Image Server', 
    status: 'running',
    endpoints: {
      images: '/images/calino/'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// History storage endpoints
const historyDataPath = path.join(__dirname, 'history-data');

// Ensure history data directory exists
async function ensureHistoryDirectory() {
  try {
    await fs.mkdir(historyDataPath, { recursive: true });
  } catch (error) {
    console.error('Error creating history directory:', error);
  }
}

// Get user history
app.get('/api/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 0, limit = 10, search = '' } = req.query;
    
    const userHistoryPath = path.join(historyDataPath, `${userId}.json`);
    
    let history = [];
    try {
      const historyData = await fs.readFile(userHistoryPath, 'utf8');
      history = JSON.parse(historyData);
    } catch (error) {
      // File doesn't exist yet, return empty history
      history = [];
    }
    
    // Filter by search if provided
    let filteredHistory = history;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredHistory = history.filter(item => 
        item.prompt.toLowerCase().includes(searchLower)
      );
    }
    
    // Pagination
    const startIndex = parseInt(page) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedHistory = filteredHistory.slice(startIndex, endIndex);
    
    res.json({
      items: paginatedHistory,
      totalPages: Math.ceil(filteredHistory.length / parseInt(limit)),
      currentPage: parseInt(page),
      totalItems: history.length
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
    
    const userHistoryPath = path.join(historyDataPath, `${userId}.json`);
    
    // Load existing history
    let history = [];
    try {
      const historyData = await fs.readFile(userHistoryPath, 'utf8');
      history = JSON.parse(historyData);
    } catch (error) {
      // File doesn't exist yet, start with empty array
      history = [];
    }
    
    // Add new item to the beginning
    history.unshift(historyItem);
    
    // Keep only the most recent 200 items on server
    history = history.slice(0, 200);
    
    // Save back to file
    await fs.writeFile(userHistoryPath, JSON.stringify(history, null, 2));
    
    res.json({ success: true, totalItems: history.length });
    
  } catch (error) {
    console.error('Error saving history:', error);
    res.status(500).json({ error: 'Failed to save history' });
  }
});

// Initialize history directory on startup
ensureHistoryDirectory();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Images available at: http://localhost:${PORT}/images/calino/`);
  console.log(`History API available at: http://localhost:${PORT}/api/history/`);
});