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
    const rawCookies = process.env.YOUTUBE_COOKIES?.trim();
    if (!rawCookies) return null;

    // Only pass a Netscape cookies.txt export to yt-dlp. Cloud hosts can
    // auto-generate arbitrary secrets for optional environment variables.
    // Those must never be mistaken for a cookies file.
    const lines = rawCookies.split(/\r?\n/);
    const header = lines[0]?.trim();
    const validHeader = header === "# Netscape HTTP Cookie File" ||
        header === "# HTTP Cookie File";

    const cookieLines = lines.filter(line =>
        line.trim() &&
        !line.startsWith("#") &&
        line.split("\t").length === 7
    );

    if (!validHeader || cookieLines.length === 0) {
        console.warn("Ignoring YOUTUBE_COOKIES: expected a Netscape cookies.txt export. Remove the variable if not needed.");
        return null;
    }

    const cookiePath = "/tmp/youtube-cookies.txt";
    fs.writeFileSync(cookiePath, rawCookies + "\n", { mode: 0o600 });
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


            console.error(
                err
            );



            res.status(500).json({

                error:
                "Failed to extract audio",

                message:
                err.message

            });


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
