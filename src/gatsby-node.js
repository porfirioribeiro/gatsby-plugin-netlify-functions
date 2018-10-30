import path from 'path';
import fs from 'fs';
import glob from 'glob';
import base64 from 'base-64';
// import babel from "@babel/core";
var babel = require('@babel/core');
import { cloneDeep } from 'lodash';

function handleErr(err, res) {
  res.statusCode = 500;
  res.send(`Function invocation failed: ` + err.toString());
  console.log(`Error during invocation: `, err);
}

function createCallback(res) {
  return function callback(err, lambdaResponse) {
    if (err) {
      handleErr(err, res);
      return;
    }

    res.statusCode = lambdaResponse.statusCode;
    for (const key in lambdaResponse.headers) {
      res.setHeader(key, lambdaResponse.headers[key]);
    }
    res.write(
      lambdaResponse.isBase64Encoded ? base64.decode(lambdaResponse.body) : lambdaResponse.body
    );
    res.end();
    return;
  };
}

function promiseCallback(promise, callback) {
  if (promise && typeof promise.then === `function` && typeof callback === `function`)
    promise.then(data => callback(null, data), err => callback(err, null));
}

const defaultExtensions = ['.es6', '.es', '.js', '.mjs', '.ts'];

function resolveFile(dir, name, extensions) {
  return extensions.map(ext => path.join(dir, name) + ext).find(fs.existsSync);
}

function fileIsNewer(src, out) {
  return fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs;
}

exports.onPreInit = (o, { functionsSrc, functionsOutput }) => {
  if (!fs.existsSync(functionsSrc))
    o.reporter.panic(
      'You need to set `functionSrc` option to gatsby-plugin-netlify-functions with an existing folder'
    );
  if (!fs.existsSync(functionsOutput)) fs.mkdirSync(functionsOutput);
};

exports.onCreateDevServer = (
  { app },
  { functionsSrc, functionsOutput, extensions = defaultExtensions }
) => {
  app.use(`/.netlify/functions/`, (req, res, next) => {
    const func = req.path.replace(/\/$/, ``);
    const moduleSrc = resolveFile(functionsSrc, func, extensions);
    const moduleOut = path.join(functionsOutput, func) + '.js';
    if (!moduleSrc) return handleErr(new Error('Module not found'), res);

    if (!fs.existsSync(moduleOut) || fileIsNewer(moduleSrc, moduleOut)) {
      transpile(functionsSrc, moduleSrc, moduleOut);
    }

    let handler;
    try {
      delete require.cache[moduleOut];
      handler = require(moduleOut);
    } catch (err) {
      res.statusCode = 500;
      res.send(`Function invocation failed: ` + err.toString());
      return;
    }
    const isBase64 = req.body && !(req.headers[`content-type`] || ``).match(/text|application/);

    const lambdaRequest = {
      path: req.path,
      httpMethod: req.method,
      queryStringParameters: req.query || {},
      headers: req.headers,
      body: isBase64 ? base64.encode(req.body) : req.body,
      isBase64Encoded: isBase64,
    };

    const callback = createCallback(res);
    const promise = handler.handler(lambdaRequest, {}, callback);
    promiseCallback(promise, callback);
  });
};

exports.onPostBuild = ({}, { functionsSrc, functionsOutput, extensions = defaultExtensions }) => {
  const modules = glob.sync(`*.{${extensions.map(s => s.slice(1)).join()}}`, { cwd: functionsSrc });
  modules.forEach(src => {
    const moduleSrc = path.join(functionsSrc, src);
    const moduleOut = path.join(functionsOutput, path.basename(src, path.extname(src)) + '.js');
    transpile(functionsSrc, moduleSrc, moduleOut);
  });
};

function transpile(functionsSrc, moduleSrc, moduleOut) {
  console.log('Compile module: ', moduleSrc);
  const out = babel.transformFileSync(moduleSrc, {
    babelrc: true,
    babelrcRoots: functionsSrc,
    // sourceMaps: true,
    // sourceRoot: functionsSrc,
    // minified: true,
    presets: [
      [
        '@babel/preset-env',
        {
          targets: {
            node: '8.10',
          },
        },
      ],
      '@babel/preset-typescript',
    ],
  });
  fs.writeFileSync(moduleOut, out.code);
}
