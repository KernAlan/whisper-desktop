const fs = require("fs-extra");
const path = require("path");

class Logger {
  constructor({ logFilePath }) {
    this.logFilePath = logFilePath || path.join(process.cwd(), "logs", "app.log");
    this.maxFiles = Number.parseInt(process.env.APP_LOG_MAX_FILES || "", 10) || 3;
    fs.ensureDirSync(path.dirname(this.logFilePath));
  }

  _dayStamp(date = new Date()) {
    const d = date;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  _dailyLogPath(date = new Date()) {
    const dir = path.dirname(this.logFilePath);
    const parsed = path.parse(this.logFilePath);
    const ext = parsed.ext || ".log";
    return path.join(dir, `${parsed.name}-${this._dayStamp(date)}${ext}`);
  }

  getCurrentLogPath() {
    return this._dailyLogPath(new Date());
  }

  async _pruneArchives() {
    const dir = path.dirname(this.logFilePath);
    const parsed = path.parse(this.logFilePath);
    const ext = parsed.ext || ".log";
    const prefix = `${parsed.name}-`;
    const entries = await fs.readdir(dir).catch(() => []);
    const archives = entries
      .filter((name) => name.startsWith(prefix) && name.endsWith(ext))
      .map((name) => path.join(dir, name));

    if (archives.length <= this.maxFiles) return;

    const withStat = await Promise.all(
      archives.map(async (filePath) => ({
        filePath,
        stat: await fs.stat(filePath).catch(() => null),
      }))
    );

    const sorted = withStat
      .filter((x) => x.stat)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .map((x) => x.filePath);

    const toDelete = sorted.slice(this.maxFiles);
    await Promise.all(toDelete.map((filePath) => fs.remove(filePath).catch(() => {})));
  }

  _serialize(args) {
    return args
      .map((item) => {
        if (item instanceof Error) return item.stack || item.message;
        if (typeof item === "string") return item;
        try {
          return JSON.stringify(item);
        } catch (_error) {
          return String(item);
        }
      })
      .join(" ");
  }

  _writeToConsole(level, ...args) {
    if (level === "ERROR") {
      console.error(...args);
    } else if (level === "WARN") {
      console.warn(...args);
    } else {
      console.log(...args);
    }
  }

  _write(level, ...args) {
    const message = this._serialize(args);
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    this._writeToConsole(level, ...args);

    const targetLogFile = this.getCurrentLogPath();
    this._pruneArchives()
      .then(() => fs.appendFile(targetLogFile, `${line}\n`))
      .catch(() => {
        // Do not crash app on log write errors.
      });
  }

  log(...args) {
    this._write("INFO", ...args);
  }

  warn(...args) {
    this._write("WARN", ...args);
  }

  error(...args) {
    this._write("ERROR", ...args);
  }
}

module.exports = {
  Logger,
};
