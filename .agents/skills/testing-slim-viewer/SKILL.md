---
name: testing-slim-viewer
description: How to run and end-to-end test the Slim digital pathology WSI viewer locally (dev server, DICOMweb config, viewer/zoom/annotation/tag-browser flows) including known breakages and workarounds.
---

# Testing the Slim WSI viewer locally

## Run the app

```bash
cd /home/ubuntu/repos/slim
REACT_APP_CONFIG=<config> BROWSER=none pnpm run start   # → http://localhost:3000/slim
```

`pnpm install` first if `node_modules` is stale. Configs live in `public/config/*.js`; the
`REACT_APP_CONFIG` value selects the file name (e.g. `demo` → `public/config/demo.js`). You can drop an
untracked config file in that directory and select it by name — useful for pointing at a different
DICOMweb server without touching tracked files.

## Picking a DICOMweb server that actually has data

- `local` (the default in `.env`) points at a dcm4chee archive that is usually empty → empty worklist.
- `demo` now points at the IDC public proxy and serves ~100 real studies. It previously pointed at
  `https://idc-external-006.uc.r.appspot.com/dcm4chee-arc/aets/DCM4CHEE/rs`, which returns 404 — so if the
  worklist is empty, verify the endpoint before assuming a code bug:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' "<server-url>/studies?limit=1"
  ```
- The IDC public proxy used by `public/config/preview.js` works and serves real TCGA slides:
  `https://proxy.imaging.datacommons.cancer.gov/current/viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb`
  A good known-good study is `TCGA-B6-A0WW`, slide `TCGA-B6-A0WW-01Z-00-DX1`.
- Port 3000 is often still held by a previous dev server; `craco` just prints "Something is already running
  on port 3000." Free it with `fuser -k 3000/tcp` before restarting.
- Set `disableWorklist: false` and `disableAnnotationTools: false` in your test config, and add an
  `annotations: [{ finding: {...} }]` entry, otherwise the annotation tool is unusable.

## Gamma-correction API mismatch (fixed — keep the pattern in mind)

`dicom-microscopy-viewer` 0.48.22 does not implement `getPaletteDisplayGammaCorrectionEnabled()` /
`setPaletteDisplayGammaCorrectionEnabled()`. These were once called unconditionally in
`src/components/SlideViewer.tsx` while being declared as required in
`types/dicom-microscopy-viewer/index.d.ts`, so TypeScript could not catch it and opening any slide
white-paged with `TypeError: ... is not a function`.

The fix (PR #6) optional-chains the call sites, declares the two methods **optional** in the `.d.ts`, and
makes `getPaletteDisplayGammaCorrectionMenu()` return `null` when the setter is undefined — so on
dmv 0.48.22 the Settings → Display section shows only "ICC Profiles" and no "Gamma correction" row at all.

General lesson for this repo: `types/dicom-microscopy-viewer/index.d.ts` is a **hand-maintained** stub, not
generated from the library. It can declare methods the installed dmv build does not have. If you see a
`... is not a function` TypeError from `volumeViewer`, check the installed dist before assuming an env issue:

```bash
grep -rc "<MethodNameFragment>" node_modules/dicom-microscopy-viewer/dist/dynamic-import/*.js
```

Declare such methods optional in the `.d.ts` and guard both the call sites and any UI that exposes them.

## Exercising the flows in the UI

- Worklist: `http://localhost:3000/slim` — expect a paged studies table.
- Open a study row → click a slide in the left "Slides" panel → OpenLayers canvas renders H&E tissue.
- Magnification: scroll-wheel zoom over tissue; the scale bar (bottom-right) is the reliable
  magnification indicator (2 mm → 500 µm → 100 µm → 50 µm). Pause ~2 s per step for tiles to load, and
  verify sharpness with a `zoom` capture rather than trusting the full screenshot.
- Pan: left-click drag on the canvas; the coordinate readout (top-right of the canvas) and the
  bottom-left overview inset rectangle both update.
- Drawing an ROI: click the "Draw ROI [Alt+D]" toolbar icon → pick a finding + geometry type → Select.
  **A press-drag-release does NOT draw — it pans.** Use click (first corner) → move → click (second
  corner). The ROI then appears in the right sidebar under Annotations as "ROI 1".
- Settings: gear icon in the top-right header opens a Display/Segmentation/Parametric Map drawer.
- DICOM Tag Browser: the third header icon; lists real tags (e.g. `(0008,0060) Modality SM`).

## Reading console evidence

The app logs `retrieve frame N of color image at tile position (x, y) at zoom level L` for every tile
fetch — this is the cleanest proof that deeper pyramid levels are actually being requested while zooming.
`[warning] coordinates of Polygon contain negative numbers` is emitted constantly once an ROI exists and
appears to be benign noise.

## Devin Secrets Needed

None — the IDC public proxy requires no authentication.
