# Calino Image Server

Static image hosting server for the Calino Figma plugin.

## Setup

```bash
npm install
npm start
```

## Deployment to Railway

1. Create new Railway project
2. Connect this repository
3. Deploy

## Endpoints

- `GET /` - Server info
- `GET /health` - Health check
- `GET /images/calino/dummy-*.png` - Image files

## Usage in Figma Plugin

Update your manifest.json to include the Railway URL in allowedDomains:
```json
"allowedDomains": [
  "https://your-app-name.up.railway.app"
]
```