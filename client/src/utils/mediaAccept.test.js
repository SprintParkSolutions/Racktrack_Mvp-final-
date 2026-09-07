// The accept list decides which picker a phone opens and which files a desktop
// dialog lets the user click. Both rules below came from tester reports, so
// they are pinned here rather than left to the comment in mediaAccept.js.

import { describe, test, expect } from 'vitest';
import { imageAccept, IMAGE_MIME_TYPES, IMAGE_EXTENSIONS, VIDEO_ACCEPT } from './mediaAccept';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const entries = (ua) => imageAccept(ua).split(',');

describe('image accept list', () => {
  test('every photo format is offered, with image/* first', () => {
    for (const ua of [ANDROID_UA, IPHONE_UA, WINDOWS_UA]) {
      const list = entries(ua);
      expect(list[0]).toBe('image/*');
      for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/gif', 'image/bmp', 'image/tiff']) {
        expect(list).toContain(mime);
      }
    }
  });

  test('on Android every entry is an image MIME type and nothing else', () => {
    // A bare extension the device cannot classify drops Chrome's chooser to
    // the generic scope, the one that offers a sound recorder next to the
    // camera. MIME types only keeps it in the image scope.
    const list = entries(ANDROID_UA);
    expect(list.every((e) => e.startsWith('image/'))).toBe(true);
    expect(list).toEqual(IMAGE_MIME_TYPES);
  });

  test('desktop and iPhone also get the bare extensions for the file dialog', () => {
    // Windows has no MIME mapping for HEIC or AVIF until the codec packs are
    // installed, so without the extensions the dialog filter hides those files.
    for (const ua of [WINDOWS_UA, IPHONE_UA]) {
      const list = entries(ua);
      for (const ext of ['.heic', '.heif', '.avif', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.jpg', '.jpeg', '.png']) {
        expect(list).toContain(ext);
      }
      expect(list).toEqual([...IMAGE_MIME_TYPES, ...IMAGE_EXTENSIONS]);
    }
  });

  test('an unknown or empty user agent is treated as desktop', () => {
    expect(entries('')).toContain('.heic');
    expect(entries(undefined)).toContain('.heic');
  });

  test('the video list stays the single wildcard', () => {
    expect(VIDEO_ACCEPT).toBe('video/*');
  });
});
