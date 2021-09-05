'use strict';

const { join, parse, isAbsolute } = require('path');
const { promisify } = require('util');
const { EOL } = require('os');
const { Client } = require('ssh2');
const execa = require('execa');
const Debug = require('debug');
const assert = require('assert');
const { validate } = require('./validate');

const { isArray } = Array;

const ERRORS = {
  /** 创建上传的临时目录异常 */
  ERR_MK_TMP_DIR: 1001,

  /** 上传文件异常 */
  ERR_PUT_FILE: 1002,

  /** 解压文件异常 */
  ERR_UNZIP: 1003,

  /** 获取容器ID异常 */
  ERR_GET_CID: 1004,

  /** 删除文件异常 */
  ERR_RM_FILE: 1005,

  /** 复制内容异常 */
  ERR_CP_DIR: 1006,

  /** 移动文件异常 */
  ERR_MV_DIR: 1007,

  /** 非法参数异常 */
  ERR_ILLEGAL_ARGUMENT: 1008,

  /** 打tar包异常异常 */
  ERR_TAR_DIR: 1009
};

function deploy (config, callback) {
  if (typeof callback !== 'function') {
    callback = () => {};
  }

  // 校验配置参数
  validate(config, (errors) => {
    throw errors[0];
  });

  let {
    host,
    port = 22,
    username,
    password,
    privateKey, // ssh密钥
    cname, // docker容器name,
    dist, // 待上传的文件夹或者文件，当服务器不支持unzip解压时使用
    zipFile, // 压缩文件路径
    zipInnerName,
    archiveDirName, // 压缩文件里面的目录名称
    staticDir,
    remoteStatic, // 静态资源存放目录
    debug: debugEnabled // 是否开启debug信息打印
  } = config;

  // 兼容1.x
  if (zipInnerName && !archiveDirName) {
    archiveDirName = zipInnerName;
  }
  if (staticDir && !remoteStatic) {
    remoteStatic = staticDir;
  }
  if (!remoteStatic ||
    !remoteStatic.trim() ||
    /\s*[*]\s*/.test(remoteStatic) ||
    /^\s*[/]+\s*$/.test(remoteStatic)) {
    const e = '无效参数 remoteStatic 或者 staticDir';
    callback(createError(e, ERRORS.ERR_ILLEGAL_ARGUMENT, e));
    return;
  }

  const debug = Debug('fast-deploy');
  debug.enabled = !!debugEnabled;

  const conn = new Client();

  debug(`ssh -p ${port} ${username}@${host}`);
  conn
    .on('ready', async () => {
      debug('准备上传');

      const rexec = promisify(conn.exec).bind(conn);
      let stream;
      let remoteTmpDir;
      let remoteTmpStatic;

      try {
        // 创建临时目录
        try {
          stream = await rexec('mktemp -d');
          remoteTmpDir = await streamify(stream);
          remoteTmpDir = remoteTmpDir.replace(new RegExp(`(${EOL})+$`), '');
          if (!remoteTmpDir) {
            throw new Error('不能创建临时文件');
          }
        } catch (e) {
          callback(createError(e, ERRORS.ERR_MK_TMP_DIR, `创建 ${remoteTmpDir} 异常`));
          return;
        }

        debug(`创建临时目录: ${remoteTmpDir}`);

        if (zipFile) {
          if (!isAbsolute(zipFile)) {
            zipFile = join(process.cwd(), zipFile);
          }
          const zipObj = parse(zipFile);
          const remoteZipFile = join(remoteTmpDir, zipObj.base);

          // 上传zip包
          let sftp;
          try {
            sftp = await promisify(conn.sftp).call(conn);
            await promisify(sftp.fastPut).call(sftp, zipFile, remoteZipFile);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_PUT_FILE, `上传 ${zipFile} 至 ${remoteZipFile} 异常`));
            return;
          } finally {
            sftp && sftp.end();
          }

          debug(`上传文件 ${zipFile} 至 ${remoteZipFile}`);

          // 解压
          try {
            stream = await rexec(`unzip -q ${remoteZipFile} -d ${remoteTmpDir}`);
            await streamify(stream);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_UNZIP, `解压 ${remoteZipFile} 至目录 ${remoteTmpDir} 异常`));
            return;
          }

          remoteTmpStatic = join(remoteTmpDir, archiveDirName || '');
          debug(`解压文件 ${remoteZipFile} 至 ${remoteTmpStatic}`);
        } else if (dist) {
          if (!isAbsolute(dist)) {
            dist = join(process.cwd(), dist);
          }

          const distObj = parse(dist);
          const remoteGZipFileName = `${distObj.name}.tar.gz`;
          try {
            await execa('tar', ['-zcf', remoteGZipFileName, distObj.name, '-C', dist]);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_TAR_DIR, `打tar包异常 ${dist}`));
          }

          const remoteZipFile = join(remoteTmpDir, remoteGZipFileName);
          zipFile = join(distObj.dir, remoteGZipFileName);

          // 上传zip包
          let sftp;
          try {
            sftp = await promisify(conn.sftp).call(conn);
            await promisify(sftp.fastPut).call(sftp, zipFile, remoteZipFile);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_PUT_FILE, `上传 ${zipFile} 至 ${remoteZipFile} 异常`));
            return;
          } finally {
            sftp && sftp.end();
          }

          try {
            await execa('rm', ['-f', zipFile]);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_RM_FILE, `删除文件 ${remoteGZipFileName}`));
          }

          // 解压
          try {
            stream = await rexec(`tar -zxf ${remoteZipFile} -C ${remoteTmpDir}`);
            await streamify(stream);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_UNZIP, `解压 ${remoteZipFile} 至目录 ${remoteTmpDir} 异常`));
            return;
          }

          remoteTmpStatic = join(remoteTmpDir, distObj.name);
          debug(`上传 ${dist} 至 ${remoteTmpStatic}`);
        } else {
          const e = '无效参数 zipFile 或者 dist';
          callback(createError(e, ERRORS.ERR_ILLEGAL_ARGUMENT, e));
          return;
        }

        if (cname) {
          // 获取容器ID
          let cid;
          try {
            stream = await rexec(`docker ps --filter name=${cname}`);
            const info = await streamify(stream);
            const rows = info.split(EOL);
            if (rows.length && rows[1]) {
              cid = rows[1].split(/\s+/)[0];
              if (!cid) {
                throw new Error(`未找到name=${cname}对应的容器`);
              }
            } else {
              throw new Error(`未找到name=${cname}对应的容器`);
            }
          } catch (e) {
            callback(createError(e, ERRORS.ERR_GET_CID, `docker ps --filter name=${cname} 异常`));
            return;
          }

          debug(`获取容器ID: ${cid}`);

          // 删除历史
          try {
            stream = await rexec(`docker exec ${cid} rm -fr ${remoteStatic}`);
            await streamify(stream);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_RM_FILE, `删除容器 ${cid} 中的 ${remoteStatic} 异常`));
            return;
          }

          debug(`删除容器 ${cid} 中的静态资源目录 ${remoteStatic}`);

          // 复制内容至容器
          try {
            stream = await rexec(`docker cp ${remoteTmpStatic} ${cid}:${remoteStatic}`);
            await streamify(stream);
          } catch (e) {
            callback(createError(e, ERRORS.ERR_CP_DIR, `复制 ${remoteTmpStatic} 至 ${cid}:${remoteStatic} 异常`));
            return;
          }

          debug(`复制 ${remoteTmpStatic} 至 ${cid}:${remoteStatic}`);
        } else {
          // 删除上一次的静态目录
          try {
            stream = await rexec(`rm -fr ${remoteStatic}`);
            await streamify(stream);
          } catch (e) {
            // 没有权限情况
            if (e.indexOf('Permission denied') > -1) {
              try {
                stream = await rexec(`sudo rm -fr ${remoteStatic}`, { pty: true });
                await streamify(stream, password);
              } catch (e1) {
                callback(createError(e1, ERRORS.ERR_RM_FILE, `删除静态资源目录 ${remoteStatic} 异常`));
                return;
              }
            } else {
              callback(createError(e, ERRORS.ERR_RM_FILE, `删除静态资源目录 ${remoteStatic} 异常`));
              return;
            }
          }

          debug(`删除静态资源目录 ${remoteStatic}`);

          // 移动内容至静态目录
          try {
            stream = await rexec(`mv ${remoteTmpStatic} ${remoteStatic}`);
            await streamify(stream);
          } catch (e) {
            // 没有权限情况
            if (e.indexOf('Permission denied') > -1) {
              try {
                stream = await rexec(`sudo mv ${remoteTmpStatic} ${remoteStatic}`, { pty: true });
                await streamify(stream, password);
              } catch (e1) {
                callback(createError(e1, ERRORS.ERR_MV_DIR, `移动 ${remoteTmpStatic} 至 ${remoteStatic} 异常`));
                return;
              }
            } else {
              callback(createError(e, ERRORS.ERR_MV_DIR, `移动 ${remoteTmpStatic} 至 ${remoteStatic} 异常`));
              return;
            }
          }

          debug(`移动 ${remoteTmpStatic} 至 ${remoteStatic}`);
        }
      } finally {
        // 删除临时目录
        try {
          stream = await rexec(`rm -fr ${remoteTmpDir}`);
          await streamify(stream);
          debug(`删除临时目录 ${remoteTmpDir}`);
        } catch (e) {
          callback(createError(e, ERRORS.ERR_RM_FILE, `删除目录 ${remoteTmpDir} 异常`));
        } finally {
          conn.end();
        }
      }
      // 完成
      callback();
    })
    .connect({
      host,
      port,
      username,
      password,
      privateKey
    });
}

function createError (err, code, reason) {
  if (typeof err !== 'object') {
    err = new Error(err);
  }
  err.code = code;
  if (reason) {
    err.reason = reason;
  }
  return err;
}

function streamify (stream, password) {
  return new Promise((resolve, reject) => {
    let info = '';
    let error = '';
    let pwsent = false;
    stream
      .on('close', (code) => {
        if (!code) {
          resolve(info);
        } else {
          reject(error);
        }
      })
      .on('data', (data) => {
        // 需要输入密码的情况
        if (password) {
          if (!pwsent) {
            info += data;
            if (info.substr(-2) === ': ') {
              pwsent = true;
              stream.write(`${password}\n`);
              info = '';
            }
          }
        } else {
          info += data;
        }
      })
      .stderr
      .on('data', (data) => {
        error += data;
      });
  });
}

deploy.promisify = promisify(deploy);

function dispatch (configs, start, length, errors, callback) {
  if (start >= length) {
    callback(errors);
    return;
  }
  deploy(configs[start], (err) => {
    errors[start] = err;
    dispatch(configs, ++start, length, errors, callback);
  });
}

function batch (configs, callback) {
  if (typeof callback !== 'function') {
    callback = () => {};
  }

  assert(configs && typeof configs === 'object', '配置参数异常');
  if (!isArray(configs)) {
    configs = [configs];
  }

  dispatch(configs, 0, configs.length, [], callback);
}

exports.deploy = deploy;
exports.batch = batch;
exports.ERRORS = ERRORS;
