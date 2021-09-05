'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  $data: true
});
require('ajv-keywords')(ajv, ['instanceof', 'typeof']);

const compiledSchema = ajv.compile({
  title: 'FastDeployOptions',
  type: 'object',
  additionalProperties: false,
  required: [
    'host',
    'port',
    'username'
    // 'password'
  ],
  properties: {
    host: { type: 'string' },
    port: { type: 'number' },
    username: { type: 'string' },
    password: { type: 'string' },
    privateKey: { },
    cname: { type: 'string' },
    dist: { type: 'string' },
    zipFile: { type: 'string' },
    archiveDirName: { type: 'string' },
    zipInnerName: { type: 'string' },
    remoteStatic: { type: 'string' },
    staticDir: { type: 'string' },
    debug: { type: 'boolean' }
  }
});

function friendlyError (obj) {
  const err = new Error(`FastDeployConfig${obj.dataPath} ${obj.message}`);
  err.raw = obj;
  return err;
}

exports.validate = function (resolved, cb) {
  const valid = compiledSchema(resolved);
  !valid && cb && cb(compiledSchema.errors.map(friendlyError));
};
