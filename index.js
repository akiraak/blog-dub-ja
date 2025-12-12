#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ... (CommandRunner, DirectoryManager クラスは変更なしのため省略) ...

// ==========================================
// 1. コマンド実行管理クラス (CommandRunner)
// ==========================================
class CommandRunner {
  async run(command, args, inputBody = null, captureOutput = true) {
    return new Promise((resolve, reject) => {
      const cmdStr = `${command} ${args.join(' ')}`;
      const inputLen = inputBody ? inputBody.length : 0;
      console.error(`[Exec] Running: ${cmdStr} (Input: ${inputLen} chars)...`);

      const child = spawn(command, args, {
        stdio: ['pipe', captureOutput ? 'pipe' : 'inherit', 'inherit']
      });

      let outputData = '';
      if (captureOutput) {
        child.stdout.on('data', (chunk) => { outputData += chunk.toString(); });
      }

      child.on('error', (err) => { reject(new Error(`Failed to start process: ${err.message}`)); });
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`Process exited with code ${code}`));
        else resolve(captureOutput ? outputData.trim() : true);
      });

      if (inputBody && inputBody.trim().length > 0) child.stdin.write(inputBody);
      child.stdin.end();
    });
  }
}

// ==========================================
// 2. ディレクトリ・パス管理クラス (DirectoryManager)
// ==========================================
class DirectoryManager {
  constructor(baseOutputDir) {
    this.baseOutputDir = baseOutputDir;
    this.projectDir = null;
    this.debugRoot = null;
    this.dirs = {}; 
    this.timestamp = ''; 
  }

  initializeProject(projectName) {
    const cleanName = this._sanitizeFilename(projectName);
    this.projectDir = path.join(this.baseOutputDir, cleanName);

    if (!fs.existsSync(this.baseOutputDir)) fs.mkdirSync(this.baseOutputDir, { recursive: true });
    if (!fs.existsSync(this.projectDir)) fs.mkdirSync(this.projectDir, { recursive: true });
    
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    this.timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    console.error(`[Dir] Project Directory ready: ${this.projectDir}`);
    return this.projectDir;
  }

  setupDebugDirectories(debugPath) {
    if (!debugPath) return;

    // パス文字列が渡されたらそれを使い、trueだけなら自動生成する
    if (typeof debugPath === 'string') {
      this.debugRoot = debugPath;
    } else {
      this.debugRoot = path.join(this.projectDir, `debug_${this.timestamp}`);
    }

    if (!fs.existsSync(this.debugRoot)) fs.mkdirSync(this.debugRoot, { recursive: true });

    this.dirs = {
      extract: path.join(this.debugRoot, 'extract-readability'),
      translateTitle: path.join(this.debugRoot, 'translate-to-ja-title'),
      translateContent: path.join(this.debugRoot, 'translate-to-ja-content'),
      tts: path.join(this.debugRoot, 'text-to-speech')
    };
  }
  
  getDebugPath(key) { return this.dirs[key] || null; }
  
  generateOutputFilename(projectName, extension) {
    return path.join(this.projectDir, `${this._sanitizeFilename(projectName)}_${this.timestamp}.${extension}`);
  }

  _sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '_').slice(0, 50);
  }
}

// ==========================================
// 3. メインロジック
// ==========================================
class BlogDubber {
  constructor(config) {
    this.config = config;
    this.runner = new CommandRunner();
    this.dirManager = new DirectoryManager(config.OUTPUT_DIR);
  }

  // ... (extract, translate, generateAudio メソッドは変更なしのため省略) ...
  async extract(url, debugPath) {
    const args = [this.config.EXTRACT_CMD, url];
    if (debugPath) args.push('--debug-dir', debugPath);
    const rawOutput = await this.runner.run('npx', args, null, true);
    try {
      const match = rawOutput.match(/\{\s*"/);
      const jsonStart = match ? match.index : -1;
      const jsonEnd = rawOutput.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) throw new Error("JSON not found in output");
      return JSON.parse(rawOutput.substring(jsonStart, jsonEnd + 1));
    } catch (e) { throw new Error(`Extraction failed: ${e.message}`); }
  }

  async translate(text, debugPath) {
    if (!text) return "";
    const args = [this.config.TRANSLATE_CMD];
    if (debugPath) args.push('--debug-dir', debugPath);
    let output = await this.runner.run('npx', args, text, true);
    return output.replace(/^\[dotenv@.+/gm, '').trim();
  }

  async generateAudio(text, outputPath, debugPath) {
    if (!text) return;
    const args = [this.config.TTS_CMD, '-o', outputPath];
    if (this.config.TTS_MODEL) args.push('--model', this.config.TTS_MODEL);
    if (debugPath) args.push('--debug-dir', debugPath);
    return this.runner.run('npx', args, text, false);
  }

  async execute(targetUrl, outputName, isDebug) {
    let projectName = outputName;
    if (!projectName) {
      try {
        const urlObj = new URL(targetUrl);
        const timestamp = Date.now().toString().slice(-6);
        projectName = `${urlObj.hostname.replace(/\./g, '_')}_${timestamp}`;
      } catch { projectName = `job_${Date.now()}`; }
    }

    try {
      // プロジェクト初期化（デバッグフォルダ等のために実行はしておく）
      this.dirManager.initializeProject(projectName);
      this.dirManager.setupDebugDirectories(debugPath);

      console.error('\n[Phase 1] Extracting Article...');
      const article = await this.extract(targetUrl, this.dirManager.getDebugPath('extract'));
      console.error(`Title: ${article.title}`);

      console.error('\n[Phase 2] Translating Title...');
      const titleJa = await this.translate(`Translate this title to Japanese: ${article.title}`, this.dirManager.getDebugPath('translateTitle'));

      console.error('\n[Phase 3] Translating Content...');
      const contentJa = await this.translate(article.content, this.dirManager.getDebugPath('translateContent'));

      // ★修正: テキスト出力パスの決定ロジック
      const textPath = this.config.TXT_OUTPUT 
        ? path.resolve(this.config.TXT_OUTPUT) 
        : this.dirManager.generateOutputFilename(projectName, 'txt');

      const textData = `Title: ${titleJa}\n\n${contentJa}`;
      fs.writeFileSync(textPath, textData);
      console.error(`\n[Save] Text saved: ${textPath}`);

      console.error('\n[Phase 4] Generating Audio...');

      // ★修正: 音声出力パスの決定ロジック
      const audioPath = this.config.MP3_OUTPUT
        ? path.resolve(this.config.MP3_OUTPUT)
        : this.dirManager.generateOutputFilename(projectName, 'mp3');

      await this.generateAudio(contentJa, audioPath, this.dirManager.getDebugPath('tts'));

      console.error(`\n✅ All Done!`);
      // 標準出力にパスを出す
      console.log(audioPath);

    } catch (error) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  }
}

// ==========================================
// CLI 設定 (Commander)
// ==========================================
program
  .name('blog-dub-ja')
  .description('ブログ記事から日本語吹き替え音声を生成するツール')
  .argument('<url>', 'ブログ記事のURL')
  .option('-o, --output <name>', 'プロジェクト名')
  .option('-d, --debug-dir <path>', 'デバッグログの出力先ディレクトリ')
  .option('--tts <type>', 'TTSエンジン (google | openai)', 'google')
  .option('--base-dir <path>', '出力ファイルのルートディレクトリ')
  // ★追加: 出力ファイル名を直接指定するオプション
  .option('--mp3-output <path>', 'MP3ファイルの出力パス (指定した場合こちらが優先されます)')
  .option('--txt-output <path>', 'テキストファイルの出力パス (指定した場合こちらが優先されます)')
  .action(async (url, options) => {
    
    const useGoogle = options.tts === 'google';
    const config = {
      EXTRACT_CMD: 'extract-readability',
      TRANSLATE_CMD: 'translate-to-ja',
      TTS_CMD: useGoogle ? 'tts-google' : 'text-to-speech',
      TTS_MODEL: useGoogle ? 'ja-JP-Chirp3-HD-Despina' : 'gpt-4o-mini-tts',
      OUTPUT_DIR: options.baseDir || path.join(__dirname, 'outputs'),
      // ★追加: コンフィグに渡す
      MP3_OUTPUT: options.mp3Output,
      TXT_OUTPUT: options.txtOutput
    };

    const debugPath = options.debugDir; // パス文字列のまま受け取る
    const dubber = new BlogDubber(config);
    await dubber.execute(url, options.output, debugPath);
  });

program.parse(process.argv);