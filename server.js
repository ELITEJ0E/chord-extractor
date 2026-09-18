import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";


const app = express();

app.use(express.json());


const MAX_DURATION_SECONDS = 600;



// ============================
// Health
// ============================

app.get("/", (req,res)=>{

    res.json({
        status:"ok",
        service:"chord-extractor-backend"
    });

});


// Check yt-dlp installed
app.get("/debug", (req,res)=>{

    const proc = spawn(
        "yt-dlp",
        ["--version"]
    );


    let output="";


    proc.stdout.on(
        "data",
        d=>{
            output += d.toString();
        }
    );


    proc.on(
        "close",
        ()=>{
            res.json({
                yt_dlp_version: output.trim()
            });
        }
    );

});



// ============================
// yt-dlp metadata
// ============================

function runYtDlpJson(url){

    return new Promise((resolve,reject)=>{


        const proc = spawn(
            "yt-dlp",
            [
                "-J",
                "--no-playlist",
                url
            ]
        );


        let data="";
        let error="";



        proc.stdout.on(
            "data",
            d=>{
                data += d.toString();
            }
        );



        proc.stderr.on(
            "data",
            d=>{
                error += d.toString();
            }
        );



        proc.on(
            "close",
            code=>{


                if(code !== 0){

                    console.error(
                        "YT-DLP ERROR:",
                        error
                    );


                    return reject(
                        new Error(error)
                    );

                }



                try{

                    resolve(
                        JSON.parse(data)
                    );


                }catch(e){

                    reject(
                        new Error(
                            "Invalid JSON from yt-dlp"
                        )
                    );

                }


            }
        );


    });


}




// ============================
// yt-dlp download
// ============================

function runYtDlpDownload(
    url,
    outputTemplate
){


    return new Promise(
        (resolve,reject)=>{


            const proc = spawn(
                "yt-dlp",
                [
                    "-x",
                    "--audio-format",
                    "mp3",
                    "--audio-quality",
                    "5",
                    "--no-playlist",
                    "-o",
                    outputTemplate,
                    url
                ]
            );


            let error="";



            proc.stderr.on(
                "data",
                d=>{
                    error += d.toString();
                }
            );



            proc.on(
                "close",
                code=>{


                    if(code===0){

                        resolve();

                    }else{


                        console.error(
                            "DOWNLOAD ERROR:",
                            error
                        );


                        reject(
                            new Error(error)
                        );

                    }


                }
            );


        }
    );


}




// ============================
// Extract
// ============================

app.post(
"/extract",
async(req,res)=>{


    const {
        url
    } = req.body || {};



    if(
        !url ||
        !/youtu\.?be/.test(url)
    ){

        return res.status(400).json({

            error:
            "A valid YouTube URL is required."

        });

    }



    const jobId =
        crypto.randomBytes(8).toString("hex");



    const tmpDir =
        os.tmpdir();



    const outputTemplate =
        path.join(
            tmpDir,
            `${jobId}.%(ext)s`
        );



    try{


        console.log(
            "Processing:",
            url
        );



        const meta =
            await runYtDlpJson(url);



        if(
            meta.duration &&
            meta.duration > MAX_DURATION_SECONDS
        ){

            return res.status(413).json({

                error:
                "Video too long."

            });

        }




        await runYtDlpDownload(
            url,
            outputTemplate
        );



        const files =
            fs.readdirSync(tmpDir);



        const audioFile =
            files.find(
                file=>
                    file.startsWith(jobId)
                    &&
                    file.endsWith(".mp3")
            );



        if(!audioFile){

            return res.status(500).json({

                error:
                "MP3 not created."

            });

        }



        const audioPath =
            path.join(
                tmpDir,
                audioFile
            );



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
                audioPath
            );



        stream.pipe(res);



        stream.on(
            "close",
            ()=>{

                fs.unlink(
                    audioPath,
                    ()=>{}
                );

            }
        );



    }catch(err){


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




// ============================
// OPTIONS
// ============================

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


});




// ============================
// Start
// ============================

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
