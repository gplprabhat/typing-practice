const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const initSqlJs = require("sql.js");

const port = Number(process.env.PORT) || 3000;
const pagePath = path.join(__dirname, "index.html");
const databasePath = path.join(__dirname, "samples.sqlite");
const maxRequestBytes = 1024 * 1024;

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bodyLength = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      bodyLength += chunk.length;
      if (bodyLength > maxRequestBytes) {
        tooLarge = true;
        reject(new Error("Request body is too large."));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function saveDatabase(database) {
  const temporaryPath = `${databasePath}.tmp`;
  fs.writeFileSync(temporaryPath, Buffer.from(database.export()));
  fs.renameSync(temporaryPath, databasePath);
}

function getSamples(database) {
  const result = database.exec("SELECT id, title, text, created_at FROM samples ORDER BY created_at DESC, rowid DESC");
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function createServer(database) {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;

    if (pathname === "/api/samples") {
      if (request.method === "GET") {
        sendJson(response, 200, { samples: getSamples(database) });
        return;
      }
      if (request.method === "POST") {
        let sample;
        try {
          sample = await readJson(request);
        } catch (error) {
          sendJson(response, error.message === "Request body is too large." ? 413 : 400, { error: error.message });
          return;
        }
        const title = sample && typeof sample.title === "string" ? sample.title.trim() : "";
        const text = sample && typeof sample.text === "string" ? sample.text.trim() : "";
        if (!title || title.length > 80) {
          sendJson(response, 400, { error: "Enter a sample name between 1 and 80 characters." });
          return;
        }
        if (!text || text.length > 10000) {
          sendJson(response, 400, { error: "Enter passage text between 1 and 10,000 characters." });
          return;
        }
        const created = {
          id: randomUUID(),
          title,
          text,
          created_at: new Date().toISOString(),
        };
        const statement = database.prepare("INSERT INTO samples (id, title, text, created_at) VALUES (?, ?, ?, ?)");
        try {
          statement.run([created.id, created.title, created.text, created.created_at]);
        } finally {
          statement.free();
        }
        try {
          saveDatabase(database);
        } catch (error) {
          console.error("Could not save the sample database:", error.message);
          database.run("DELETE FROM samples WHERE id = ?", [created.id]);
          sendJson(response, 500, { error: "Could not save the sample. Check that the application folder is writable." });
          return;
        }
        sendJson(response, 201, { sample: created });
        return;
      }
      response.writeHead(405, { Allow: "GET, POST" });
      response.end("Method not allowed");
      return;
    }

    const sampleId = pathname.match(/^\/api\/samples\/([^/]+)$/);
    if (sampleId) {
      if (request.method !== "DELETE") {
        response.writeHead(405, { Allow: "DELETE" });
        response.end("Method not allowed");
        return;
      }
      let id;
      try {
        id = decodeURIComponent(sampleId[1]);
      } catch {
        sendJson(response, 400, { error: "Invalid sample ID." });
        return;
      }
      const existing = database.exec(
        "SELECT id, title, text, created_at FROM samples WHERE id = ?",
        [id],
      );
      if (!existing.length || !existing[0].values.length) {
        sendJson(response, 404, { error: "Sample not found." });
        return;
      }
      const deletedSample = existing[0].values[0];
      const statement = database.prepare("DELETE FROM samples WHERE id = ?");
      try {
        statement.run([id]);
      } finally {
        statement.free();
      }
      try {
        saveDatabase(database);
      } catch (error) {
        console.error("Could not save the sample database:", error.message);
        database.run(
          "INSERT INTO samples (id, title, text, created_at) VALUES (?, ?, ?, ?)",
          deletedSample,
        );
        sendJson(response, 500, { error: "Could not delete the sample. Check that the application folder is writable." });
        return;
      }
      sendJson(response, 200, { deleted: true });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

    if (pathname !== "/" && pathname !== "/index.html") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    fs.readFile(pagePath, (error, contents) => {
      if (error) {
        console.error(`Could not read ${pagePath}:`, error.message);
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Could not load the typing practice page.");
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": contents.length,
      });
      response.end(request.method === "HEAD" ? undefined : contents);
    });
  });
}

initSqlJs({
  locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file),
}).then((SQL) => {
  const isNewDatabase = !fs.existsSync(databasePath);
  const database = isNewDatabase
    ? new SQL.Database()
    : new SQL.Database(fs.readFileSync(databasePath));
  database.run(`
    CREATE TABLE IF NOT EXISTS samples (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  if (isNewDatabase) {
    database.run(
      "INSERT INTO samples (id, title, text, created_at) VALUES (?, ?, ?, ?)",
      [
        "starter-daily-focus",
        "Daily focus",
        "The best way to learn is to practice a little every day. Focus on accuracy first, and your speed will grow with time.",
        new Date().toISOString(),
      ],
    );
  }
  saveDatabase(database);

  const server = createServer(database);
  server.on("error", (error) => {
    console.error(`Could not start the local website: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "localhost", () => {
    const address = `http://localhost:${port}/`;
    console.log(`Typing practice is running at ${address}`);
    console.log("Keep this window open while you use the site. Press Ctrl+C to stop.");
    if (process.env.TYPING_PRACTICE_NO_BROWSER !== "1") {
      exec(`start "" "${address}"`, (error) => {
        if (error) console.error(`Could not open a browser: ${error.message}`);
      });
    }
  });
}).catch((error) => {
  console.error("Could not initialize SQLite sample storage:", error.message);
  process.exitCode = 1;
});
