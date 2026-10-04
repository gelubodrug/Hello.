'use strict'
// Hello runs the dsh host under Electron as Node with --expose-internals, which
// answers these ids directly. The upstream addon pins exact Electron V8 builds.
const PREFIX = 'internal/'
function isAllowedInternalId(moduleId) {
  return typeof moduleId === 'string' && moduleId.startsWith(PREFIX)
}
function requireBuiltin(moduleId) {
  if (!isAllowedInternalId(moduleId)) throw new Error(`node-addon-require-builtin (Hello): ${String(moduleId)} is not an internal module id`)
  if (!process.execArgv.includes('--expose-internals')) throw new Error('node-addon-require-builtin (Hello): start the host with --expose-internals')
  return require(moduleId)
}
function getBindingInfo() {
  return Object.freeze({ mode: 'expose-internals', product: 'require-builtin', backend: 'flag', node: process.versions.node, status: 'ok', result: 'supported' })
}
module.exports = { requireBuiltin, isAllowedInternalId, getBindingInfo }
module.exports.default = module.exports
