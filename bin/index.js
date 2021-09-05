#!/usr/bin/env node

const { join, isAbsolute } = require('path');
const { existsSync, writeFileSync } = require('fs');
const { format } = require('util');
const { Command } = require('commander');
const { green, red, yellow } = require('chalk');
const { batch } = require('../index');
const VERSION = require('../package.json').version;

const templateConfig = `
module.exports = {
  host: '47.105.135.120', // 服务器IP
  port: 12672, // 服务器端口
  username: 'root', // 用户名
  password: '******', // 密码
  cname: 'nginx', // 容器名，例如nginx、aibox等
  dist: '', // 待上传的文件夹或者文件，当服务器不支持unzip解压时使用
  // zipFile: 'build.zip', // 压缩文件路径
  // archiveDirName: 'build', // 压缩文件里面的目录名称（通常打包时外层目录被打包进入压缩文件）
  remoteStatic: '/root/static/saas/xxxxxx', // 静态资源存放目录
  debug: true // 是否开启debug信息打印
};
`;

const program = new Command();

program
  .name('fast-deploy')
  .version(VERSION, '-v, --version')
  .option('-c, --config [value]', '通过配置信息部署代码')
  .usage('[options]')
  .on('--help', () => {
    const content = `
  Examples:
    $ fast-deploy -c
    $ fast-deploy --config
    $ fast-deploy -h
`;
    console.log(green(content));
  });

program
  .name('fast-deploy')
  .arguments('[cmd]')
  .description('初始化一个配置文件')
  .action((cmd) => {
    if (cmd === 'init') {
      const cwd = process.cwd();
      let configPath = join(cwd, 'fast-deploy.config.js');
      if (existsSync(configPath)) {
        console.log(yellow('fast-deploy.config.js 已存在'));
        configPath = join(cwd, `fast-deploy-${Date.now().toString(36)}.config.js`);
      }
      writeFileSync(configPath, templateConfig, 'utf8');
      console.log(green('创建 fast-deploy.config.js 完成'));
    }
  })
  .on('--help', () => {
    const content = `
  Examples:
    $ fast-deploy <init>
`;
    console.log(green(content));
  });

// program.missingArgument = function (name) {
//   console.log(red(`missing required argument <${name}>
//     `));
//   program.help();
//   process.exit(1);
// };

program.parse(process.argv);

let configPath = program.config;

if (configPath !== undefined) {
  if (configPath === true) {
    configPath = 'fast-deploy.config.js';
  }
  if (!isAbsolute(configPath)) {
    configPath = join(process.cwd(), configPath);
  }

  const config = require(configPath);

  console.log(green('部署开始!'));
  console.log('');
  batch(config, (errors) => {
    errors.forEach((error) => {
      error && console.log(red(format(error)));
      console.log('');
    });
    console.log(green('部署结束!'));
  });
} else if (!program.args.length) {
  program.help();
}
