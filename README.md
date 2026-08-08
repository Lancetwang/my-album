# my-album

A lightweight, dependency-free photo album browser that runs entirely in the browser. Open it locally, choose a photo folder, and browse your collection without uploading images or running a backend.

## Features

- Local-first and private: images are read from the folder you select and stay on your device.
- No build step, package manager, server, or external dependency.
- Folder-based albums with support for root-level images through a default album.
- Timeline view with grouping by day and ascending or descending sort order.
- Full-screen viewer with keyboard navigation, touch swiping, zooming, and panning.
- Recently Deleted for logical photo deletion, recovery, and automatic cleanup after 30 days.
- Optional album creation, renaming, and deletion when read/write access is available.
- IndexedDB persistence for the selected folder handle, sort preference, and Recently Deleted data.

## Quick start

1. Download or clone this repository.
2. Create a folder for your photos. Each immediate subfolder becomes an album:

   ```text
   photos/
   ├── Travel 2025/
   │   ├── 001.jpg
   │   └── 002.jpg
   └── Family/
       └── 001.png
   ```

3. Open `index.html` in a supported browser.
4. Select the `photos` folder, or drag it onto the page.

If the selected folder has no subfolders, its root-level images are shown as `Default Album`. When subfolders are present, only images inside those immediate subfolders are included; deeper directory levels are ignored.

## Supported image formats

The application recognizes JPG, JPEG, PNG, GIF, WebP, BMP, SVG, AVIF, TIF, and TIFF files. Actual decoding depends on the browser. HEIC files are not included and may need to be converted before use.

## Browser compatibility

The full experience works best in a Chromium-based browser with the File System Access API, such as current Chrome or Edge. This enables folder selection and, when permission is granted, album management.

Browsers that support `webkitdirectory` can use the compatibility picker for browsing. Compatibility mode is read-only, and drag-and-drop support varies by browser.

Because of browser security restrictions, the application must receive an explicit folder selection or drop action before it can read local files. It cannot automatically scan neighboring folders.

## Data and deletion behavior

- No image data is uploaded; the application has no backend or network service.
- The browser stores the selected folder handle, preferences, and Recently Deleted thumbnails in local IndexedDB storage.
- Moving a photo to Recently Deleted hides it in the application but does not remove the original file from disk. It can be restored or purged from the local Recently Deleted list.
- Deleting an album is different: with read/write permission, it permanently removes that folder and its contents from disk after confirmation.

## Development

There is no build process. Edit the HTML, CSS, or JavaScript files directly and reload the page.

For a local development server, use any static file server. Python's standard library is sufficient:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/` in your browser.

## License

[MIT](./LICENSE)
