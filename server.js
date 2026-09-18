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
// Health check
// ===============================

app.get("/", (req, res) => {
    res.json({
        status: "ok",
        service: "chord-extractor-backend"
    });
});


// ===============================
// Cookie support
// ===============================

function getCookieFile() {

    if (!process.env.YOUTUBE_COOKIES) {
        return null;
    }


    const cookiePath = "/tmp/youtube-cookies.txt";


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
            "--no-playlist"
        ];


        const cookies = getCookieFile();


        if (cookies) {

            args.push(
                "--cookies",
                cookies
            );

        }


        args.push(url);



        const proc = spawn(
            "yt-dlp",
            args
        );


        let data = "";
        let error = "";



        proc.stdout.on(
            "data",
            (d) => {
                data += d.toString();
            }
        );


        proc.stderr.on(
            "data",
            (d) => {
                error += d.toString();
            }
        );



        proc.on(
            "close",
            (code) => {


                if (code !== 0) {

                    console.error(
                        "YT-DLP METADATA ERROR:",
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

                } catch {

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
// yt-dlp download
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

            "--no-playlist"

        ];



        const cookies = getCookieFile();



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



        const proc = spawn(
            "yt-dlp",
            args
        );



        let error = "";



        proc.stderr.on(
            "data",
            (d) => {
                error += d.toString();
            }
        );



        proc.on(
            "close",
            (code) => {


                if (code === 0) {

                    resolve();

                } else {


                    console.error(
                        "YT-DLP DOWNLOAD ERROR:",
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
    async (req, res) => {


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
                    `Video too long. Maximum ${
                        MAX_DURATION_SECONDS / 60
                    } minutes.`

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
                    "Audio extraction failed."

                });

            }



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
                    mp3Path
                );


            stream.pipe(res);



            stream.on(
                "close",
                () => {

                    fs.unlink(
                        mp3Path,
                        () => {}
                    );

                }
            );



        } catch (err) {


            console.error(err);



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
// CORS preflight
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
