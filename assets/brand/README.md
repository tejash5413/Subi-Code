# Subi Code brand assets

`subi-code-source.png` is the exact transparent PNG supplied by the user.
`subi-code.png` and `subi-code.ico` are derived launcher assets. The source
artwork is cropped to its alpha bounds, then centered with an 8% inset on each
side; its colors and aspect ratio are preserved.

Regenerate with Python 3 and Pillow:

```powershell
python script/brand-assets.py
```

Format generated TypeScript with the repository's Prettier command afterward.
The generator updates the desktop dev/beta/prod PNG, ICO and ICNS sets, browser
favicons, VS Code icon, shared UI/OAuth images, and terminal artwork. No image
library is required at application runtime. The main terminal header retains
the original large block `SUBI CODE` lettering: blue for `SUBI`, purple for
`CODE`. Narrow layouts retain their compact text/monogram fallback. Pixel
approximations generated from the icon are not used for that main header.

CLI Windows builds embed `subi-code.ico`. Desktop prebuild copies the selected
channel icons into `resources/icons`; run it before packaging. Native execution
has been checked locally on Windows only. Linux and macOS icon formats can be
decoded here, but their applications still need native qualification.
