import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const app = express();

app.use(
  express.json({
    limit: "10kb"
  })
);

const MAX_DURATION_SECONDS = 600;


// =====================================
// Health Check
// =====================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "chord-extractor-backend"
  });
});


app.get("/health", (req, res) => {
  res.status(200).json({
    healthy: true
  });
});


// =====================================
// yt-dlp Metadata Extraction
// =====================================

function runYtDlpJson(url) {

  return new Promise((resolve, reject) => {

    const proc = spawn("yt-dlp", [

      "-J",

      "--no-playlist",

      "--extractor-args",
      "youtube:player_client=android",

      "--user-agent",
      "Mozilla/5.0",

      url
    ]);


    let data = "";
    let error = "";


    proc.stdout.on("data", (chunk) => {
      data += chunk.toString();
    });


    proc.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });


    proc.on("close", (code) => {


      if (code !== 0) {

        console.error(
          "yt-dlp metadata error:",
          error
        );


        return reject(
          new Error(
            error || "Could not read video metadata."
          )
        );

      }


      try {

        resolve(
          JSON.parse(data)
        );

      } catch (err) {

        reject(
          new Error(
            "Invalid metadata response."
          )
        );

      }

    });

  });

}


// =====================================
// yt-dlp Audio Download
// =====================================

function runYtDlpDownload(url, outputTemplate) {

  return new Promise((resolve, reject) => {


    const proc = spawn("yt-dlp", [

      "-x",

      "--audio-format",
      "mp3",

      "--audio-quality",
      "5",

      "--no-playlist",


      "--extractor-args",
      "youtube:player_client=android",


      "--user-agent",
      "Mozilla/5.0",


      "-o",
      outputTemplate,


      url

    ]);


    let error = "";


    proc.stderr.on("data", (chunk) => {

      error += chunk.toString();

    });


    proc.on("close", (code) => {


      if (code === 0) {

        resolve();

      } else {


        console.error(
          "yt-dlp download error:",
          error
        );


        reject(
          new Error(
            error || "Audio extraction failed."
          )
        );

      }

    });


  });

}


// =====================================
// Extract Endpoint
// =====================================

app.post("/extract", async (req, res) => {


  const { url } = req.body || {};



  if (
    !url ||
    !/youtu\.?be/.test(url)
  ) {

    return res.status(400).json({

      error:
      "A valid YouTube URL is required."

    });

  }



  const jobId =
    crypto.randomBytes(8).toString("hex");



  const tempDir =
    os.tmpdir();



  const outputTemplate =
    path.join(
      tempDir,
      `${jobId}.%(ext)s`
    );



  try {


    console.log(
      "Extracting:",
      url
    );



    const meta =
      await runYtDlpJson(url);




    if (
      meta.duration &&
      meta.duration > MAX_DURATION_SECONDS
    ) {


      return res.status(413).json({

        error:
        `Video exceeds ${MAX_DURATION_SECONDS / 60} minute limit.`

      });

    }



    await runYtDlpDownload(
      url,
      outputTemplate
    );



    const files =
      fs.readdirSync(tempDir);



    const audioFile =
      files.find(file =>

        file.startsWith(jobId)
        &&
        (
          file.endsWith(".mp3") ||
          file.endsWith(".m4a") ||
          file.endsWith(".webm")
        )

      );



    if (!audioFile) {


      return res.status(500).json({

        error:
        "Audio file was not created."

      });

    }



    const audioPath =
      path.join(
        tempDir,
        audioFile
      );



    res.setHeader(
      "Content-Type",
      "audio/mpeg"
    );


    res.setHeader(
      "X-Video-Title",
      encodeURIComponent(
        meta.title || "YouTube Track"
      )
    );


    res.setHeader(
      "X-Video-Artist",
      encodeURIComponent(
        meta.uploader || ""
      )
    );


    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );


    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Video-Title,X-Video-Artist"
    );



    const stream =
      fs.createReadStream(
        audioPath
      );



    stream.pipe(res);



    stream.on(
      "close",
      () => {

        fs.unlink(
          audioPath,
          () => {}
        );

      }
    );



  } catch (err) {


    console.error(
      err
    );


    res.status(500).json({

      error:
      "Failed to extract audio.",

      message:
      err.message

    });


  }


});


// =====================================
// CORS OPTIONS
// =====================================

app.options("/extract", (req, res) => {


  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );


  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST,OPTIONS"
  );


  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );


  res.status(200).end();

});


// =====================================
// Start Server (Render)
// =====================================

const PORT =
  process.env.PORT || 8080;



app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Extractor listening on ${PORT}`
    );

  }
);
