---
name: testing-slim-viewer
description: How to run and end-to-end test the Slim digital pathology viewer (React + dicom-microscopy-viewer) locally against real whole-slide DICOM data, including how to get slides to actually render and how to demonstrate magnification/zoom.
---

# Testing the Slim digital pathology viewer

## Toolchain

Slim needs **Node 24** — the system default (Node 20) makes pnpm fail with
`No such built-in module: node:sqlite`. In every new shell:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
corepack enable && corepack prepare pnpm@11.9.0 --activate
cd <repo> && pnpm install
```

## Getting real slides to view (no credentials)

The shipped configs are not usable out of the box for testing:

- `public/config/local.js` (the `.env` default) points at a local dcm4chee on `localhost:8008` that needs
  `docker-compose up -d` **plus** manually STOWing whole-slide DICOM — no images without that work.
- `public/config/preview.js` points at the public IDC proxy but forces Google OIDC sign-in.

Create an untracked `public/config/devin.js` that reuses the public IDC DICOMweb proxy **without** OIDC,
then start with `REACT_APP_CONFIG=devin`:

```js
window.config = {
  path: '/',
  servers: [{
    id: 'idc-preview',
    url: 'https://proxy.imaging.datacommons.cancer.gov/current/viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb',
    write: false
  }],
  disableWorklist: false,
  disableAnnotationTools: true,   // proxy is read-only
  enableServerSelection: true,
  mode: 'light',
  preload: true,
  annotations: [],
  logger: { level: 'WARN', enableInProduction: false, enableInDevelopment: true }
}
```

```bash
REACT_APP_CONFIG=devin BROWSER=none pnpm run start   # http://localhost:3000
```

Verify the endpoint first with QIDO: `/studies?limit=3&ModalitiesInStudy=SM` should return 200 with real
slide-microscopy studies. The worklist only queries `ModalitiesInStudy=SM`.

## Likely blocker: viewer route crashes on a missing DMV API

If every `/studies/.../series/...` route shows a red CRA "Uncaught runtime errors" overlay such as
`volumeViewer.<someMethod> is not a function`, the pinned published `dicom-microscopy-viewer` npm package
is **behind the Slim source**, which calls newer DMV APIs in `src/components/SlideViewer.tsx`. This may
recur whenever Slim lands code ahead of a DMV release. Workaround: build and link DMV master.

```bash
git clone https://github.com/ImagingDataCommons/dicom-microscopy-viewer ~/repos/dmv
cd ~/repos/dmv && pnpm install
pnpm run webpack:dynamic-import      # REQUIRED — slim imports dist/dynamic-import, not src
cd <slim repo> && pnpm link ~/repos/dmv
# restart the dev server; the old one keeps serving the stale bundle
```

Gotchas:
- `pnpm link --global` fails if `~/.local/share/pnpm/bin` is not on `PATH`.
- `pnpm link dicom-microscopy-viewer` fails with `ERR_PNPM_LINK_BAD_PARAMS` — you must pass a **path**.
- `pnpm link <path>` rewrites `pnpm-lock.yaml` and `pnpm-workspace.yaml`; revert both after testing.

## Good study to test with

Patient ID `TCGA-DU-7300`, slide `TCGA-DU-7300-01Z-00-DX1` (**FFPE HE TP DX1**) — a brightfield H&E brain
slide with obvious pink/purple tissue and clean nuclei at high zoom. Filter for it with the **Patient ID**
column search icon in the worklist. Other reliable SM studies: `PBCFZC`, `HTA7_989`, `PBCBUW`, `C3L-06117`.

## Demonstrating magnification

- There are **no +/- zoom buttons**: `viewerUtils.ts` passes only `controls: ['overview','position']`,
  so zoom is **mouse wheel over the canvas** only.
- The "Go to" modal has an explicit `Magnification [0-40]` input, but its toolbar button renders only when
  `enableAnnotationTools` is true. With a read-only server config it is unreachable — say so in the report
  rather than claiming it was tested.
- The **scale bar (bottom-right)** is the magnification indicator. On the TCGA-DU-7300 DX1 slide,
  ~5 wheel clicks per step walks it `2 mm → 1000 μm → 200 μm → 100 μm → 20 μm`. Screenshot each step.
- Prove the pyramid is real, not upsampling: watch the console for
  `retrieve frames N of instance <UID>` and confirm the **instance UID changes** between zoom levels
  (e.g. `...560.36.0` at fit vs `...560.8.0` at max). Also check the overview thumbnail's viewport
  rectangle shrinks and the top-right mm coordinate readout changes.
- Tiles over the public proxy are slow — wait 10-15 s after each zoom/pan before screenshotting.

## Expected benign noise (do not report as new failures, but do disclose)

- N × `Failed to fetch ICC profiles (Source: dicom-microscopy-viewer)` — the public proxy returns a
  non-image bulkdata response. Drives the header error badge count. Rendering is unaffected.
  Open the header bug-icon → "Debug Information" to confirm Communication/Decoding/Auth categories are empty.
- `Warning: [antd: Menu] children will be removed in next major version.`

## Other UI worth covering

- Optical-path eye toggle (right panel) genuinely blanks the canvas **and** the overview thumbnail.
- DICOM Tag Browser: header file-search icon, only on `/studies/` routes. Has a working tag search box
  (`Modality` → `(0008,0060) = SM`) and an instance slider.
- Memory footer is enabled by default (`App.tsx`) and updates live; it rose from ~139 MB on the worklist to
  ~214 MB during max-zoom tile loading.

## Window management on this box

The active X display is `:0`, not `:1`. Maximize before recording with:

```bash
DISPLAY=:0 wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz
```

## Devin Secrets Needed

None. The public IDC DICOMweb proxy requires no credentials.
