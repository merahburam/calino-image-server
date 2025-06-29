#!/bin/bash

# Copy images from source to destination
SOURCE_DIR="/Users/achmadalimin/Documents/3 Merahburam/Figma Plugins/website/portfolio/app/images/calino"
DEST_DIR="/Users/achmadalimin/Documents/3 Merahburam/Figma Plugins/calino-image-server/public/images/calino"

echo "Copying images from $SOURCE_DIR to $DEST_DIR"

# Copy all dummy images
cp "$SOURCE_DIR"/*.png "$DEST_DIR/"

echo "Copy complete!"
ls -la "$DEST_DIR"