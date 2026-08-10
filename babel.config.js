module.exports = {
  presets: [
    '@babel/preset-env',
    // Match the `react-jsx` runtime that tsconfig.json and the CRA build use,
    // so that components do not have to import React to be testable.
    ['@babel/preset-react', { runtime: 'automatic' }],
    '@babel/preset-typescript'
  ]
}
