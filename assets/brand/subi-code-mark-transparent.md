# Transparent in-app mark

`subi-code-mark-transparent.png` is the selected transparent cutout for the
shared application UI. The original opaque artwork is preserved separately in
`subi-code-source.png`; native launcher icons continue using that original.

Created with the built-in imagegen tool from
`C:\Users\Admin\Downloads\glossy_interlocking_ribbon_emblem.png`, with
`transparent_background: true`. Generated alpha is preserved. The brand asset
pipeline makes a 256-pixel in-app copy for the embedded UI asset. Browser
compositing previews verify the cutout on dark and light backgrounds.

Final selected prompt:

> Clean production cutout of the exact supplied logo. Keep ONLY the two large
> connected white/silver folded ribbon shapes that make the S emblem. Delete
> the entire dark navy backdrop and all pixels between and outside the ribbons.
> All empty areas must be uniformly fully transparent (alpha zero), with no
> texture, speckles, fragments, particles, haze, shadows or leftover backdrop.
> Preserve the original ribbon geometry and white/silver shading faithfully.
> Smooth precise antialiased outer and inner edges. Center the isolated S mark
> on a transparent square canvas with comfortable even empty margin. Do not add
> any graphics or text. This is background removal, not a redesign.

Selected generated source:
`C:\Users\Admin\.codex\generated_images\01a142e4-f4b0-7a82-9ea8-a2664b4fe74b\exec-40334839-b0b4-45c6-85dd-3216144c6225.png`.
