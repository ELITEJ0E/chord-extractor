import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";


const app = express();

app.use(express.json());


const MAX_DURATION_SECONDS = 600;


// ===============================
// Health
// ===============================

app.get("/", (req, res) => {

    res.json({
        status: "ok",
        service: "chord-extractor-backend"
    });

});



// ===============================
// Cookie handling
// ===============================

function getCookieFile() {

    if (!process.env.YOUTUBE_COOKIES) {
        return null;
    }


    const cookiePath =
        "/tmp/youtube-cookies.txt";


    fs.writeFileSync(
        cookiePath,
        process.env.YOUTUBE_COOKIES
    );


    return cookiePath;

}



// ===============================
// yt-dlp metadata
// ===============================

function runYtDlpJson(url) {

    return new Promise((resolve, reject) => {


        const args = [

            "-J",

            "--no-playlist",

            "--js-runtimes",
            "deno",
            "--remote-components",
            "ejs:npm"

        ];



        const cookies =
            getCookieFile();



        if (cookies) {

            args.push(
                "--cookies",
                cookies
            );

        }



        args.push(url);



        const proc =
            spawn(
                "yt-dlp",
                args
            );



        let data = "";

        let error = "";



        proc.stdout.on(
            "data",
            chunk => {

                data += chunk.toString();

            }
        );



        proc.stderr.on(
            "data",
            chunk => {

                error += chunk.toString();

            }
        );



        proc.on(
            "close",
            code => {


                if (code !== 0) {


                    console.error(
                        error
                    );


                    return reject(
                        new Error(error)
                    );

                }



                try {

                    resolve(
                        JSON.parse(data)
                    );

                }

                catch {

                    reject(
                        new Error(
                            "Invalid metadata response"
                        )
                    );

                }


            }
        );


    });

}




// ===============================
// yt-dlp audio download
// ===============================

function runYtDlpDownload(
    url,
    outputTemplate
) {


    return new Promise((resolve, reject) => {


        const args = [

            "-x",

            "--audio-format",
            "mp3",

            "--audio-quality",
            "5",

            "--no-playlist",

            "--js-runtimes",
            "deno",
            "--remote-components",
            "ejs:npm"

        ];



        const cookies =
            getCookieFile();



        if (cookies) {

            args.push(
                "--cookies",
                cookies
            );

        }



        args.push(
            "-o",
            outputTemplate,
            url
        );



        const proc =
            spawn(
                "yt-dlp",
                args
            );



        let error = "";



        proc.stderr.on(
            "data",
            chunk => {

                error += chunk.toString();

            }
        );



        proc.on(
            "close",
            code => {


                if (code === 0) {

                    resolve();

                }

                else {


                    console.error(
                        error
                    );


                    reject(
                        new Error(error)
                    );

                }


            }
        );


    });


}




// ===============================
// Extract endpoint
// ===============================

app.post(
    "/extract",
    async(req,res)=>{


        const {
            url
        } = req.body || {};



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
            crypto.randomBytes(8)
            .toString("hex");



        const tmpDir =
            os.tmpdir();



        const outputTemplate =
            path.join(
                tmpDir,
                `${jobId}.%(ext)s`
            );



        const mp3Path =
            path.join(
                tmpDir,
                `${jobId}.mp3`
            );



        let stage = "metadata";

        try {


            console.log(
                "Processing:",
                url
            );



            const meta =
                await runYtDlpJson(url);



            if (
                meta.duration &&
                meta.duration >
                MAX_DURATION_SECONDS
            ) {

                return res.status(413).json({

                    error:
                    "Video too long"

                });

            }



            stage = "download";
            await runYtDlpDownload(
                url,
                outputTemplate
            );



            stage = "audio_file";
            if (
                !fs.existsSync(mp3Path)
            ) {


                return res.status(500).json({

                    error:
                    "Audio file missing"

                });

            }



            res.setHeader(
                "Content-Type",
                "audio/mpeg"
            );


            res.setHeader(
                "X-Video-Title",
                encodeURIComponent(
                    meta.title || ""
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
                    mp3Path
                );



            stream.pipe(res);



            stream.on(
                "close",
                ()=>{

                    fs.unlink(
                        mp3Path,
                        ()=>{}
                    );

                }
            );


        }


        catch(err){


            const raw = String(err?.message || "Unknown extractor failure");
            const known = [
                ["Sign in to confirm", "YOUTUBE_BOT_CHECK", "YouTube requires verification for this server."],
                ["not a bot", "YOUTUBE_BOT_CHECK", "YouTube requires verification for this server."],
                ["HTTP Error 429", "YOUTUBE_RATE_LIMITED", "YouTube is rate-limiting this Render server (429). Retrying immediately will not resolve an IP rate limit."],
                ["HTTP Error 403", "YOUTUBE_FORBIDDEN", "YouTube denied the server's request (403)."],
                ["Requested format is not available", "FORMAT_UNAVAILABLE", "yt-dlp could not obtain an audio format."],
                ["Video unavailable", "VIDEO_UNAVAILABLE", "The selected YouTube video is unavailable."],
                ["Private video", "PRIVATE_VIDEO", "The selected YouTube video is private."],
                ["ffmpeg", "AUDIO_CONVERSION_FAILED", "Audio conversion failed; check FFmpeg installation and the Render logs."],
            ];
            const match = known.find(([needle]) => raw.toLowerCase().includes(needle.toLowerCase()));
            const errorCode = match?.[1] || "YTDLP_FAILED";
            const message = match?.[2] || "Audio extraction failed on Render. Check the backend logs for the yt-dlp error.";
            console.error("[extract]", { stage, errorCode, raw });
            if (!res.headersSent) {
                res.status(502).json({ error: message, code: errorCode, stage });
            } else {
                res.destroy(err);
            }


        }


    }
);



// ===============================
// CORS
// ===============================

app.options(
    "/extract",
    (req,res)=>{

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

    }
);



// ===============================
// Start
// ===============================

const PORT =
process.env.PORT || 8080;


app.listen(
    PORT,
    "0.0.0.0",
    ()=>{

        console.log(
            `Extractor listening on ${PORT}`
        );

    }
);
