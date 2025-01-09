import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';

const THUMBNAIL_SIZE = 200;
const THUMBNAIL_DIR = path.join(process.cwd(), 'uploads', 'thumbnails');

export async function generateThumbnail(filePath: string): Promise<string | null> {
  try {
    // Ensure thumbnail directory exists
    await fs.mkdir(THUMBNAIL_DIR, { recursive: true });

    const fileName = path.basename(filePath);
    const thumbnailPath = path.join(THUMBNAIL_DIR, `thumb_${fileName}`);

    // Generate thumbnail for images
    if (isImage(filePath)) {
      await sharp(filePath)
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .toFile(thumbnailPath);
      return thumbnailPath;
    }

    // For non-image files, return null
    return null;
  } catch (error) {
    console.error('Error generating thumbnail:', error);
    return null;
  }
}

function isImage(filePath: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const ext = path.extname(filePath).toLowerCase();
  return imageExtensions.includes(ext);
}
