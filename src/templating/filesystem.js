const pkgInstall = require('pkg-install');
const dotenv = require('dotenv');
const fs = require('fs');
const chalk = require('chalk');
const got = require('got');
const Listr = require('listr');
const path = require('path');
const { promisify } = require('util');

const access = promisify(fs.access);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

async function fileExists(filePath) {
  try {
    await access(filePath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function downloadFile(contentUrl, targetPath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(targetPath);
    got
      .stream(contentUrl)
      .on('response', resolve)
      .on('error', reject)
      .pipe(writeStream);
  });
}

async function writeEnvFile(contentUrl, targetDir, functionName) {
  const envFilePath = path.join(targetDir, '.env');
  const envFileExists = await fileExists(envFilePath);
  if (!envFileExists) {
    return downloadFile(contentUrl, envFilePath);
  }

  const currentContent = await readFile(envFilePath, 'utf8');
  const currentFlags = dotenv.parse(currentContent);
  const newContent = (await got(contentUrl)).body;
  const newFlags = dotenv.parse(newContent);

  const functionKeys = Object.keys(newFlags);
  const existingKeys = functionKeys.filter(key =>
    currentFlags.hasOwnProperty(key)
  );
  const updatedContent = newContent
    .split('\n')
    .map(line => {
      const name = line.substr(0, line.indexOf('='));
      if (existingKeys.includes(name)) {
        return '# ' + line;
      }
      return line;
    })
    .join('\n');

  const separatorContent = `

# Variables for function "${functionName}"
# ---
`;

  const contentToWrite = currentContent + separatorContent + updatedContent;
  await writeFile(envFilePath, contentToWrite, 'utf8');
  return { newEnvironmentVariableKeys: functionKeys };
}

async function installDependencies(contentUrl, targetDir) {
  const pkgContent = await got(contentUrl, { json: true });
  const dependencies = pkgContent.body.dependencies;
  return pkgInstall.install(dependencies, {
    cwd: targetDir,
  });
}

async function writeFiles(files, targetDir, functionName) {
  const functionTargetPath = path.join(
    targetDir,
    `functions/${functionName}.js`
  );
  if (await fileExists(functionTargetPath)) {
    throw new Error(
      `Function with name "${functionName} already exists in functions/ directory`
    );
  }

  const tasks = files.map(file => {
    if (file.type === 'function') {
      return {
        title: 'Create Function',
        task: () => {
          return downloadFile(file.content, functionTargetPath);
        },
      };
    } else if (file.type === '.env') {
      return {
        title: 'Configure Environment Variables in .env',
        task: async ctx => {
          const output = await writeEnvFile(
            file.content,
            targetDir,
            file.functionName
          );
          ctx.env = output;
        },
      };
    } else if (file.type === 'package.json') {
      return {
        title: 'Installing Dependencies',
        task: () => installDependencies(file.content, targetDir),
      };
    }
  });
  const context = await new Listr(tasks, { concurrent: true }).run();

  const newKeys = context.env.newEnvironmentVariableKeys;
  if (newKeys.length > 0) {
    console.log(
      chalk`{cyan INFO} Make sure to configure ${newKeys.join(
        ','
      )} in the .env file`
    );
  }
}

module.exports = {
  writeFiles,
};