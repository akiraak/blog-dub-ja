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

  setupDebugDirectories(debugPath) {
    if (!debugPath) return;

    if (!fs.existsSync(debugPath)) {
      fs.mkdirSync(debugPath, { recursive: true });
    }

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

  // ファイル保存ヘルパー
  saveText(filePath, content, label) {
    if (!filePath || !content) return null;
    const absPath = path.resolve(filePath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content);
    console.error(`[Save] ${label} saved: ${absPath}`);
    return absPath;
  }

  async execute(targetUrl, debugPath) {
    try {
      this.dirManager.setupDebugDirectories(debugPath);

      console.error('\n[Phase 1] Extracting Article...');
      const article = await this.extract(targetUrl, this.dirManager.getDebugPath('extract'));
      console.error(`Title: ${article.title}`);

      console.error('\n[Phase 2] Translating Title...');
      const titleJa = await this.translate(`Translate this title to Japanese: ${article.title}`, this.dirManager.getDebugPath('translateTitle'));

      console.error('\n[Phase 3] Translating Content...');
      const contentJa = await this.translate(article.content, this.dirManager.getDebugPath('translateContent'));

      // タイトル保存 (-t 指定時)
      const savedTitlePath = this.saveText(this.config.TITLE_TXT_PATH, titleJa, 'Title Text');

      // 本文保存 (-c 指定時)
      const savedContentPath = this.saveText(this.config.CONTENT_TXT_PATH, contentJa, 'Content Text');

      console.error('\n[Phase 4] Generating Audio...');

      // 音声保存
      const audioPath = path.resolve(this.config.MP3_OUTPUT);
      const audioDir = path.dirname(audioPath);
      if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

      // 音声には「タイトル + 本文」を含める
      const audioContent = `${titleJa}\n\n${contentJa}`;
      await this.generateAudio(audioContent, audioPath, this.dirManager.getDebugPath('tts'));

      console.error(`\n✅ All Done!`);
      
      console.error(`- MP3   : ${audioPath}`);
      if (savedTitlePath)   console.error(`- Title : ${savedTitlePath}`);
      if (savedContentPath) console.error(`- Cont. : ${savedContentPath}`);
      
      if (debugPath) {
        console.error(`- DBG   : ${path.resolve(debugPath)}`);
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
  .requiredOption('-m, --mp3-output <path>', 'MP3ファイルの出力パス (必須)')
  // ★修正: ショートハンドを小文字の1文字に変更
  .option('-t, --title-txt <path>', 'タイトルのテキスト出力パス (任意)')
  .option('-c, --content-txt <path>', '本文のテキスト出力パス (任意)')
  .option('-d, --debug-dir <path>', 'デバッグログの出力先ディレクトリ')
  .option('--tts <type>', 'TTSエンジン (google | openai)', 'google')
  .action(async (url, options) => {
    
    const useGoogle = options.tts === 'google';
    const config = {
      EXTRACT_CMD: 'extract-readability',
      TRANSLATE_CMD: 'translate-to-ja',
      TTS_CMD: useGoogle ? 'tts-google-25pro' : 'text-to-speech',
      TTS_MODEL: useGoogle ? undefined : 'gpt-4o-mini-tts',
      MP3_OUTPUT: options.mp3Output,
      TITLE_TXT_PATH: options.titleTxt,
      CONTENT_TXT_PATH: options.contentTxt
    };

    const debugPath = options.debugDir;
    const dubber = new BlogDubber(config);
    await dubber.execute(url, debugPath);
  });

program.parse(process.argv);