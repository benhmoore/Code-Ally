/**
 * Image utility functions for handling image files in messages
 */

import * as path from 'path';
import sharp from 'sharp';
import { IMAGE_PROCESSING } from '@config/constants.js';

/**
 * Supported image file extensions and their MIME types
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Check if a file path points to a supported image file
 * @param filePath - Path to the file to check
 * @returns True if the file extension matches a supported image format
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in IMAGE_EXTENSIONS;
}

/**
 * Resize and optimize an image to reduce file size while maintaining quality
 * - Resizes based on IMAGE_PROCESSING.MAX_DIMENSION (maintaining aspect ratio)
 * - Compresses to target IMAGE_PROCESSING.TARGET_SIZE_KB file size
 * - Converts PNG to JPEG if needed for size optimization
 *
 * @param filePath - Path to the image file
 * @returns Buffer containing the optimized image data
 */
async function resizeAndOptimizeImage(filePath: string): Promise<Buffer> {
  // Load image and get metadata
  const image = sharp(filePath);
  const metadata = await image.metadata();

  // Calculate resize dimensions (maintain aspect ratio)
  let width = metadata.width || IMAGE_PROCESSING.MAX_DIMENSION;
  let height = metadata.height || IMAGE_PROCESSING.MAX_DIMENSION;

  if (width > IMAGE_PROCESSING.MAX_DIMENSION || height > IMAGE_PROCESSING.MAX_DIMENSION) {
    if (width > height) {
      height = Math.round((height * IMAGE_PROCESSING.MAX_DIMENSION) / width);
      width = IMAGE_PROCESSING.MAX_DIMENSION;
    } else {
      width = Math.round((width * IMAGE_PROCESSING.MAX_DIMENSION) / height);
      height = IMAGE_PROCESSING.MAX_DIMENSION;
    }
  }

  // Resize image
  let resized = image.resize(width, height, {
    fit: 'inside',
    withoutEnlargement: true,
  });

  // Try different quality settings to get under target size
  // Start with format preference: keep original if JPEG/WebP, otherwise convert to JPEG
  const format = metadata.format === 'jpeg' || metadata.format === 'webp'
    ? metadata.format
    : 'jpeg';

  // Try quality levels from QUALITY_START down to QUALITY_MIN
  for (let quality = IMAGE_PROCESSING.QUALITY_START; quality >= IMAGE_PROCESSING.QUALITY_MIN; quality -= IMAGE_PROCESSING.QUALITY_STEP) {
    let buffer: Buffer;

    if (format === 'jpeg') {
      buffer = await resized.jpeg({ quality }).toBuffer();
    } else if (format === 'webp') {
      buffer = await resized.webp({ quality }).toBuffer();
    } else {
      buffer = await resized.toBuffer();
    }

    // If under target size, return it
    if (buffer.length <= IMAGE_PROCESSING.TARGET_SIZE_BYTES) {
      return buffer;
    }

    // Reset for next iteration
    resized = image.resize(width, height, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // If still too large, return the lowest quality version
  if (format === 'jpeg') {
    return await resized.jpeg({ quality: IMAGE_PROCESSING.QUALITY_MIN }).toBuffer();
  } else if (format === 'webp') {
    return await resized.webp({ quality: IMAGE_PROCESSING.QUALITY_MIN }).toBuffer();
  } else {
    return await resized.toBuffer();
  }
}

/**
 * Convert an image file to a base64-encoded string
 * Automatically resizes and optimizes the image before encoding
 *
 * @param filePath - Path to the image file
 * @returns Base64-encoded string of the optimized image data
 * @throws Error if file doesn't exist, cannot be read, or is not an image
 */
export async function fileToBase64(filePath: string): Promise<string> {
  // Validate that it's an image file
  if (!isImageFile(filePath)) {
    throw new Error(`File is not a supported image format: ${filePath}`);
  }

  try {
    // Resize and optimize the image
    const optimizedBuffer = await resizeAndOptimizeImage(filePath);

    // Convert to base64
    return optimizedBuffer.toString('base64');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`Image file not found: ${filePath}`);
    } else if (error.code === 'EACCES') {
      throw new Error(`Permission denied reading image file: ${filePath}`);
    } else {
      throw new Error(`Failed to process image file ${filePath}: ${error.message}`);
    }
  }
}

/**
 * Get the MIME type for an image file based on its extension
 * @param filePath - Path to the image file
 * @returns MIME type string (e.g., 'image/png', 'image/jpeg')
 * @throws Error if the file extension is not a supported image format
 */
export function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_EXTENSIONS[ext];

  if (!mimeType) {
    throw new Error(`Unsupported image format: ${ext}`);
  }

  return mimeType;
}
