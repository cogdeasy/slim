window.config = {
  path: '/slim',
  // dicom-microscopy-viewer resolves its web worker relative to `path`, which
  // drops the last segment when it has no trailing slash. Point it at the
  // bundle directory explicitly so the worker loads under a path prefix.
  publicLibPath: '/slim/static/js/',
  servers: [
    {
      id: 'demo',
      url: 'https://idc-external-006.uc.r.appspot.com/dcm4chee-arc/aets/DCM4CHEE/rs',
      write: false
    }
  ],
  preload: true,
  disableAnnotationTools: false,
  annotations: [
    {
      finding: { value: '85756007', schemeDesignator: 'SCT', meaning: 'Tissue' }
    }
  ],
  // Logger configuration
  logger: {
    level: 'WARN', // DEBUG, LOG, WARN, ERROR, NONE
    enableInProduction: false,
    enableInDevelopment: true
  }
}
