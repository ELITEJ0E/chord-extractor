import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";


const app = express();

app.use(express.json());


const MAX_DURATION_SECONDS = 600;
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
let rateLimitedUntil = 0;
const activeVideoRequests = new Set();


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

            "deno"

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
            "deno"

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



        const videoId = (() => {
            try {
                const parsed = new URL(url);
                if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(parsed.hostname)) return null;
                const value = parsed.hostname === "youtu.be" ? parsed.pathname.slice(1).split("/")[0] : parsed.searchParams.get("v");
                return /^[A-Za-z0-9_-]{11}$/.test(value || "") ? value : null;
            } catch { return null; }
        })();
        if (!videoId) return res.status(400).json({ error: "Invalid YouTube video URL", code: "INVALID_URL" });
        if (Date.now() < rateLimitedUntil) {
            const retryAfter = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(503).json({ error: "YouTube is rate-limiting this server. Please use Upload Audio, or try again later.", code: "YOUTUBE_RATE_LIMITED", retryAfterSeconds: retryAfter });
        }
        if (activeVideoRequests.has(videoId)) return res.status(429).json({ error: "This video is already being processed.", code: "ALREADY_PROCESSING" });
        activeVideoRequests.add(videoId);

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



            await runYtDlpDownload(
                url,
                outputTemplate
            );



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
            const detail = String(err?.message || "yt-dlp error");
            const rateLimited = /HTTP Error 429|Too Many Requests/i.test(detail);
            if (rateLimited) rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
            console.error(
                err
            );



            if (!res.headersSent) {
                if (rateLimited) res.setHeader("Retry-After", "1800");
                res.status(rateLimited ? 503 : 502).json({
                    error: rateLimited ? "YouTube is rate-limiting this server. Please use Upload Audio, or try again later." : "YouTube audio extraction failed. Please try an authorized audio upload instead.",
                    code: rateLimited ? "YOUTUBE_RATE_LIMITED" : "YTDLP_FAILED",
                });
            }


        } finally {
            activeVideoRequests.delete(videoId);
            fs.unlink(mp3Path, () => {});
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
