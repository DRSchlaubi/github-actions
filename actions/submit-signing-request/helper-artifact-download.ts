import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as nodeStreamZip from 'node-stream-zip';
import axios, { AxiosError } from 'axios';
import { HelperInputOutput } from "./helper-input-output";
import { httpErrorResponseToText } from './utils';


export class HelperArtifactDownload {

    constructor(private helperInputOutput: HelperInputOutput) { }

    public async downloadArtifact(artifactDownloadUrl: string): Promise<void> {
        core.info(`Signed artifact url ${artifactDownloadUrl}`);
        const response = await axios.get(artifactDownloadUrl, {
            responseType: 'stream',
            timeout: this.helperInputOutput.downloadSignedArtifactTimeoutInSeconds * 1000,
            headers: {
                Authorization: 'Bearer ' + this.helperInputOutput.signPathApiToken
            }
        })
        .catch((e: AxiosError) => {
            throw new Error(httpErrorResponseToText(e));
        });

        const targetDirectory = this.resolveOrCreateDirectory(this.helperInputOutput.outputArtifactDirectory);

        core.info(`The signed artifact is being downloaded from SignPath and will be saved to ${targetDirectory}`);

        const rootTmpDir = process.env.RUNNER_TEMP;
        const tmpDir = fs.mkdtempSync(`${rootTmpDir}${path.sep}`);
        core.debug(`Created temp directory ${tmpDir}`);

        // save the signed artifact to temp ZIP file
        const tmpZipFile = path.join(tmpDir, 'artifact_tmp.zip');
        const writer = fs.createWriteStream(tmpZipFile);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve)
            writer.on('error', reject)
        });

        core.debug(`The signed artifact ZIP has been saved to ${tmpZipFile}`);

        core.debug(`Extracting the signed artifact from ${tmpZipFile} to ${targetDirectory}`);
        // unzip temp ZIP file to the targetDirectory
        const zip = new nodeStreamZip.async({ file: tmpZipFile });
        await zip.extract(null, targetDirectory);
        core.info(`The signed artifact has been successfully downloaded from SignPath and extracted to ${targetDirectory}`);
    }

    private resolveOrCreateDirectory(relativePath:string): string {
        const absolutePath = path.join(process.env.GITHUB_WORKSPACE as string, relativePath)
        if (!fs.existsSync(absolutePath)) {
            core.info(`Directory "${absolutePath}" does not exist and will be created`);
            fs.mkdirSync(absolutePath, { recursive: true });
        }
        return absolutePath;
    }
}