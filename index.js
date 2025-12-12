#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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
  constructor() {
    this.dirs = {}; 
  }

  // デバッグディレクトリのセットアップのみを行うように簡素化
  setupDebugDirectories(debugPath) {
    if (!debugPath) return;

    // 指定されたパスを作成
    if (!fs.existsSync(debugPath)) {
      fs.mkdirSync(debugPath, { recursive: true });
    }

    // 各工程用のサブフォルダパスを定義
    this.dirs = {
      extract: path.join(debugPath, 'extract-readability'),
      translateTitle: path.join(debugPath, 'translate-to-ja-title'),
      translateContent: path.join(debugPath, 'translate-to-ja-content'),
      tts: path.join(debugPath, 'text-to-speech')
    };

    console.error(`[Debug] Logs will be saved to: ${debugPath}`);
  }
  
  getDebugPath(key) { return this.dirs[key] || null; }
}

// ==========================================
// 3. メインロジック
// ==========================================
class BlogDubber {
  constructor(config) {
    this.config = config;
    this.runner = new CommandRunner();
    this.dirManager = new DirectoryManager();
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

  async execute(targetUrl, debugPath) {
    try {
      // デバッグフォルダの準備（指定がある場合のみ）
      this.dirManager.setupDebugDirectories(debugPath);

      console.error('\n[Phase 1] Extracting Article...');
      const article = await this.extract(targetUrl, this.dirManager.getDebugPath('extract'));
      console.error(`Title: ${article.title}`);

      console.error('\n[Phase 2] Translating Title...');
      const titleJa = await this.translate(`Translate this title to Japanese: ${article.title}`, this.dirManager.getDebugPath('translateTitle'));

      console.error('\n[Phase 3] Translating Content...');
      const contentJa = await this.translate(article.content, this.dirManager.getDebugPath('translateContent'));

      // テキスト保存（必須パスへ保存）
      const textPath = path.resolve(this.config.TXT_OUTPUT);
      const textData = `Title: ${titleJa}\n\n${contentJa}`;
      
      // 保存先のディレクトリが存在しない場合は作成
      const textDir = path.dirname(textPath);
      if (!fs.existsSync(textDir)) fs.mkdirSync(textDir, { recursive: true });
      
      fs.writeFileSync(textPath, textData);
      console.error(`\n[Save] Text saved: ${textPath}`);

      console.error('\n[Phase 4] Generating Audio...');

      // 音声保存（必須パスへ保存）
      const audioPath = path.resolve(this.config.MP3_OUTPUT);
      
      // 保存先のディレクトリが存在しない場合は作成
      const audioDir = path.dirname(audioPath);
      if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

      await this.generateAudio(contentJa, audioPath, this.dirManager.getDebugPath('tts'));

      console.error(`\n✅ All Done!`);
      
      // 人間が確認しやすいように標準エラー出力にリスト表示
      console.error(`- MP3 : ${audioPath}`);
      console.error(`- TXT : ${textPath}`);
      
      if (debugPath) {
        // -d が指定されていた場合、デバッグディレクトリのフルパスを表示
        console.error(`- DBG : ${path.resolve(debugPath)}`);
      }

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
  // ★変更: 必須オプション化＆ショートハンド追加
  .requiredOption('-m, --mp3-output <path>', 'MP3ファイルの出力パス (必須)')
  .requiredOption('-t, --txt-output <path>', 'テキストファイルの出力パス (必須)')
  .option('-d, --debug-dir <path>', 'デバッグログの出力先ディレクトリ')
  .option('--tts <type>', 'TTSエンジン (google | openai)', 'google')
  // 削除: --output, --base-dir
  .action(async (url, options) => {
    
    const useGoogle = options.tts === 'google';
    const config = {
      EXTRACT_CMD: 'extract-readability',
      TRANSLATE_CMD: 'translate-to-ja',
      TTS_CMD: useGoogle ? 'tts-google' : 'text-to-speech',
      TTS_MODEL: useGoogle ? 'ja-JP-Chirp3-HD-Despina' : 'gpt-4o-mini-tts',
      MP3_OUTPUT: options.mp3Output,
      TXT_OUTPUT: options.txtOutput
    };

    const debugPath = options.debugDir;
    const dubber = new BlogDubber(config);
    await dubber.execute(url, debugPath);
  });

program.parse(process.argv);