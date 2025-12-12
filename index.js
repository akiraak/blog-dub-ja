#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ==========================================
// 1. コマンド実行管理クラス
// ==========================================
class CommandRunner {
  async run(command, args, inputBody = null, captureOutput = true) {
    return new Promise((resolve, reject) => {
      const cmdStr = `${command} ${args.join(' ')}`;
      const inputLen = inputBody ? inputBody.length : 0;
      // 標準出力ではなく標準エラー出力に進捗を出す（パイプ渡し対策）
      console.error(`[Exec] Running: ${cmdStr} (Input: ${inputLen} chars)...`);

      const child = spawn(command, args, {
        stdio: ['pipe', captureOutput ? 'pipe' : 'inherit', 'inherit']
      });

      let outputData = '';

      if (captureOutput) {
        child.stdout.on('data', (chunk) => {
          outputData += chunk.toString();
        });
      }

      child.on('error', (err) => {
        reject(new Error(`Failed to start process: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}`));
        } else {
          resolve(captureOutput ? outputData.trim() : true);
        }
      });

      if (inputBody && inputBody.trim().length > 0) {
        child.stdin.write(inputBody);
      }
      child.stdin.end();
    });
  }
}

// ==========================================
// 2. ディレクトリ・パス管理クラス
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

    if (!fs.existsSync(this.baseOutputDir)) {
      fs.mkdirSync(this.baseOutputDir, { recursive: true });
    }

    if (!fs.existsSync(this.projectDir)) {
      fs.mkdirSync(this.projectDir, { recursive: true });
    }
    
    // タイムスタンプ生成
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    this.timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    console.error(`[Dir] Project Directory ready: ${this.projectDir} (Timestamp: ${this.timestamp})`);
    return this.projectDir;
  }

  setupDebugDirectories(isDebug) {
    if (!isDebug) return;

    this.debugRoot = path.join(this.projectDir, `debug_${this.timestamp}`);
    fs.mkdirSync(this.debugRoot, { recursive: true });

    this.dirs = {
      extract: path.join(this.debugRoot, 'extract-readability'),
      translateTitle: path.join(this.debugRoot, 'translate-to-ja-title'),
      translateContent: path.join(this.debugRoot, 'translate-to-ja-content'),
      tts: path.join(this.debugRoot, 'text-to-speech')
    };
  }

  getDebugPath(key) {
    return this.dirs[key] || null;
  }

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
    } catch (e) {
      throw new Error(`Extraction failed: ${e.message}`);
    }
  }

  async translate(text, debugPath) {
    if (!text) return "";
    const args = [this.config.TRANSLATE_CMD];
    if (debugPath) args.push('--debug-dir', debugPath);
    
    let output = await this.runner.run('npx', args, text, true);
    output = output.replace(/^\[dotenv@.+/gm, '').trim();

    return output;
  }

  async generateAudio(text, outputPath, debugPath) {
    if (!text) return;

    const args = [this.config.TTS_CMD, '-o', outputPath];
    
    if (this.config.TTS_MODEL) {
      args.push('--model', this.config.TTS_MODEL);
    }

    if (debugPath) args.push('--debug-dir', debugPath);
    return this.runner.run('npx', args, text, false);
  }

  async execute(targetUrl, outputName, isDebug) {
    // プロジェクト名決定ロジック
    let projectName = outputName;
    if (!projectName) {
      try {
        const urlObj = new URL(targetUrl);
        const timestamp = Date.now().toString().slice(-6);
        projectName = `${urlObj.hostname.replace(/\./g, '_')}_${timestamp}`;
      } catch {
        projectName = `job_${Date.now()}`;
      }
    }

    try {
      this.dirManager.initializeProject(projectName);
      this.dirManager.setupDebugDirectories(isDebug);

      // --- 1. 記事抽出 ---
      console.error('\n[Phase 1] Extracting Article...');
      const article = await this.extract(targetUrl, this.dirManager.getDebugPath('extract'));
      console.error(`Title: ${article.title}`);

      // --- 2. タイトル翻訳 ---
      console.error('\n[Phase 2] Translating Title...');
      const titleJa = await this.translate(
        `Translate this title to Japanese: ${article.title}`, 
        this.dirManager.getDebugPath('translateTitle')
      );

      // --- 3. 本文翻訳 ---
      console.error('\n[Phase 3] Translating Content...');
      const contentJa = await this.translate(article.content, this.dirManager.getDebugPath('translateContent'));

      // --- テキスト保存処理 ---
      const textPath = this.dirManager.generateOutputFilename(projectName, 'txt');
      const textData = `Title: ${titleJa}\n\n${contentJa}`;
      fs.writeFileSync(textPath, textData);
      console.error(`\n[Save] Text saved: ${textPath}`);

      // --- 4. 音声合成 ---
      console.error('\n[Phase 4] Generating Audio...');
      const audioPath = this.dirManager.generateOutputFilename(projectName, 'mp3');
      await this.generateAudio(contentJa, audioPath, this.dirManager.getDebugPath('tts'));

      // --- 完了報告 ---
      console.error(`\n✅ All Done!`);
      console.error(`   Text:  ${textPath}`);
      console.error(`   Audio: ${audioPath}`);
      if (isDebug) {
        console.error(`   Debug Info saved in: ${this.dirManager.debugRoot}`);
      }
      
      // 出力ファイルのパスを標準出力に出す（親プロセスが読み取れるように）
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
  .argument('<url>', '翻訳・音声化したいブログ記事のURL')
  .option('-o, --output <name>', 'プロジェクト名（出力フォルダ名に使用）')
  .option('-d, --debug-dir <path>', 'デバッグログの出力先ディレクトリ（指定がない場合は自動生成）')
  // TTSエンジン切り替えオプション
  .option('--tts <type>', '使用するTTSエンジン (google | openai)', 'google')
  .action(async (url, options) => {
    
    // オプションに応じた設定の構築
    const useGoogle = options.tts === 'google';
    
    const config = {
      EXTRACT_CMD: 'extract-readability',
      TRANSLATE_CMD: 'translate-to-ja',
      
      // フラグに応じてコマンドとモデルを自動設定
      TTS_CMD: useGoogle ? 'tts-google' : 'text-to-speech',
      TTS_MODEL: useGoogle ? 'ja-JP-Chirp3-HD-Despina' : 'gpt-4o-mini-tts',
      
      OUTPUT_DIR: path.join(__dirname, 'outputs')
    };

    // デバッグフラグの処理 (--debug-dir があればデバッグモードとみなす)
    const isDebug = !!options.debugDir;
    
    // クラスのインスタンス化と実行
    const dubber = new BlogDubber(config);
    
    // DirectoryManagerのロジックが独自に debugフォルダを作る仕組みになっているため、
    // 引数の debug-dir を使うように少しロジック調整が必要かもしれませんが、
    // 一旦既存ロジック(自動生成)を生かす形で isDebug フラグのみ渡します。
    await dubber.execute(url, options.output, isDebug);
  });

program.parse(process.argv);