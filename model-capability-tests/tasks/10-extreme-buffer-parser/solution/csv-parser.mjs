export class CsvStreamParser {
  constructor() {
    this.decoder = new TextDecoder("utf-8");
    this.rowCallback = null;
    this.inQuote = false;
    this.row = [];
    this.field = "";
    this.lastWasQuote = false;
  }

  onRow(callback) {
    this.rowCallback = callback;
  }

  push(chunk) {
    const text = this.decoder.decode(chunk, { stream: true });
    this._processText(text);
  }

  flush() {
    const text = this.decoder.decode(); // flushes any buffered bytes
    this._processText(text);
    if (this.row.length > 0 || this.field !== "") {
      this.row.push(this.field);
      if (this.rowCallback) {
        this.rowCallback(this.row);
      }
      this.row = [];
      this.field = "";
    }
  }

  _processText(text) {
    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (this.inQuote) {
        if (char === '"') {
          if (this.lastWasQuote) {
            this.field += '"';
            this.lastWasQuote = false;
          } else {
            this.lastWasQuote = true;
          }
        } else {
          if (this.lastWasQuote) {
            this.inQuote = false;
            this.lastWasQuote = false;
            i--; // re-process current character in normal mode
          } else {
            this.field += char;
          }
        }
      } else {
        if (char === '"') {
          this.inQuote = true;
          this.lastWasQuote = false;
        } else if (char === ',') {
          this.row.push(this.field);
          this.field = "";
        } else if (char === '\n') {
          if (this.field.endsWith('\r')) {
            this.field = this.field.slice(0, -1);
          }
          this.row.push(this.field);
          if (this.rowCallback) {
            this.rowCallback(this.row);
          }
          this.row = [];
          this.field = "";
        } else if (char === '\r') {
          this.field += char;
        } else {
          this.field += char;
        }
      }
    }
  }
}
