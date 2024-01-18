import axios, { AxiosError } from 'axios';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as moment from 'moment';
import * as nodeStreamZip from 'node-stream-zip';


import url from 'url';
import { SubmitSigningRequestResult } from './dtos/submit-signing-request-result';
import { executeWithRetries } from './utils';
import { SignPathUrlBuilder } from './signpath-url-builder';
import { SigningRequestDto } from './dtos/signing-request';

const MaxWaitingTimeForSigningRequestCompletionMs = 1000 * 60 * 60;
const MinDelayBetweenSigningRequestStatusChecksMs = 1000 * 60; // start from 1 min
const MaxDelayBetweenSigningRequestStatusChecksMs = 1000 * 60 * 20; // check at least every 30 minutes

// output variables
// signingRequestId - the id of the newly created signing request
// signingRequestWebUrl - the url of the signing request in SignPath
// signPathApiUrl - the base API url of the SignPath API
// signingRequestDownloadUrl - the url of the signed artifact in SignPath

export class Task {
    urlBuilder: SignPathUrlBuilder;

    constructor () {
        this.urlBuilder = new SignPathUrlBuilder(this.signPathConnectorUrl);
    }

    async run() {
        try {
            const signingRequestId = await this.submitSigningRequest();

            if (this.outputArtifactDirectory) {
                // signed artifacts output path is specified,
                // so we need to wait for the signing request to be completed
                // and then download the signed artifact
                const signingRequest = await this.ensureSigningRequestCompleted(signingRequestId);
                await this.downloadTheSignedArtifact(signingRequest);
            }
        }
        catch (err) {
            core.setFailed((err as any).message);
        }
    }

    get signPathConnectorUrl(): string {
        return core.getInput('connector-url', { required: true });
    }

    get artifactName(): string {
        return core.getInput('artifact-name', { required: true });
    }

    get outputArtifactDirectory(): string {
        return core.getInput('output-artifact-directory', { required: false });
    }

    get organizationId(): string {
        return core.getInput('organization-id', { required: true });
    }

    get signPathToken(): string {
        return core.getInput('api-token', { required: true });
    }

    get projectSlug(): string {
        return core.getInput('project-slug', { required: true });
    }

    get gitHubToken(): string {
        return core.getInput('github-token', { required: true });
    }

    get signingPolicySlug(): string {
        return core.getInput('signing-policy-slug', { required: true });
    }

    get artifactConfigurationSlug(): string {
        return core.getInput('artifact-configuration-slug', { required: true });
    }

    private async submitSigningRequest (): Promise<string> {

        core.info('Submitting the signing request to SignPath CI connector...');

        // prepare the payload
        const submitRequestPayload = {
            apiToken: this.signPathToken,
            artifactName: this.artifactName,
            gitHubApiUrl: process.env.GITHUB_API_URL,
            gitHubWorkflowRunId: process.env.GITHUB_RUN_ID,
            gitHubRepository: process.env.GITHUB_REPOSITORY,
            gitHubToken: this.gitHubToken,
            signPathOrganizationId: this.organizationId,
            signPathProjectSlug: this.projectSlug,
            signPathSigningPolicySlug: this.signingPolicySlug,
            signPathArtifactConfigurationSlug: this.artifactConfigurationSlug
        };

        // call the signPath API to submit the signing request
        const response = (await axios
            .post<SubmitSigningRequestResult>(this.urlBuilder.buildSubmitSigningRequestUrl(),
            submitRequestPayload,
            { responseType: "json" })
            .catch((e: AxiosError) => {
                core.error(`SignPath API call error: ${e.message}.`);
                if(e.response?.data && typeof(e.response.data) === "string") {
                     throw new Error(e.response.data);
                }
                throw new Error(e.message);
            }))
            .data;

        if (response.error) {
            // got error from the connector
            throw new Error(response.error);
        }

        if (response.validationResult && response.validationResult.errors.length > 0) {

            // got validation errors from the connector
            core.startGroup('CI system setup validation errors')

            core.error(`[error]Build artifact \"${this.artifactName}\" cannot be signed because of continuous integration system setup validation errors:`);

            response.validationResult.errors.forEach(validationError => {
                core.error(`[error]${validationError.error}`);
                if (validationError.howToFix)
                {
                    core.info(validationError.howToFix);
                }
            });

            core.endGroup()

            throw new Error("CI system validation failed.");
        }

        if (!response.signingRequestId) {
            // got error from the connector
            throw new Error(`SignPath signing request was not created. Please make sure that SignPathConnectorUrl is pointing to the SignPath GitHub Actions connector endpoint.`);
        }

        const signingRequestUrlObj  = url.parse(response.signingRequestUrl);
        this.urlBuilder.signPathBaseUrl = signingRequestUrlObj.protocol + '//' + signingRequestUrlObj.host;

        core.info(`SignPath signing request has been successfully submitted`);
        core.info(`The signing request id is ${response.signingRequestId}`);
        core.info(`You can view the signing request here: ${response.signingRequestUrl}`);


        core.setOutput('signing-request-id', response.signingRequestId);
        core.setOutput('signing-request-web-url', response.signingRequestUrl);
        core.setOutput('signpath-api-url', this.urlBuilder.signPathBaseUrl + '/API');

        return response.signingRequestId;
    }

    async ensureSigningRequestCompleted(signingRequestId: string): Promise<SigningRequestDto> {
        // check for status update
        core.info(`Checking the signing request status...`);
        const requestData = await (executeWithRetries<SigningRequestDto>(
            async () => {
                const requestStatusUrl = this.urlBuilder.buildGetSigningRequestUrl(
                    this.organizationId,
                    signingRequestId);
                const signingRequestDto = (await axios
                    .get<SigningRequestDto>(
                        requestStatusUrl,
                        {
                            responseType: "json",
                            headers: {
                                "Authorization": `Bearer ${this.signPathToken}`
                            }
                        }
                    )
                    .catch((e: AxiosError) => {
                        core.error(`SignPath API call error: ${e.message}`);
                        core.error(`Signing request details API URL is: ${requestStatusUrl}`);
                        if(e.response?.data && typeof(e.response.data) === "string") {
                            throw new Error(JSON.stringify(
                                {
                                    'data': e.response.data
                                }));
                        }
                        throw new Error(e.message);
                    })
                    .then((response) => {
                        const data = response.data;
                        if(data && !data.isFinalStatus) {
                            core.info(`The signing request status is ${data.status}, which is not a final status; after a delay, we will check again...`);
                            throw new Error('Retry signing request status check.');
                        }
                        return data;
                    }));
                return signingRequestDto;
            },
            MaxWaitingTimeForSigningRequestCompletionMs,
            MinDelayBetweenSigningRequestStatusChecksMs,
            MaxDelayBetweenSigningRequestStatusChecksMs)
            .catch((e) => {
                if(e.message.startsWith('{')) {
                    const errorData = JSON.parse(e.message);
                    return errorData.data;
                }
                throw e;
            }));

        core.info(`Signing request status is ${requestData.status}`);
        if (!requestData.isFinalStatus) {
            const maxWaitingTime = moment.utc(MaxWaitingTimeForSigningRequestCompletionMs).format("hh:mm");
            core.error(`We have exceeded the maximum waiting time, which is ${maxWaitingTime}, and the signing request is still not in a final state`);
            throw new Error(`The signing request is not completed. The current status is "${requestData.status}`);
        } else {
            if (requestData.status !== "Completed") {
                throw new Error(`The signing request is not completed. The final status is "${requestData.status}"`);
            }
        }

        return requestData;
    }

    async downloadTheSignedArtifact(signingRequest: SigningRequestDto): Promise<void> {
        core.setOutput('signed-artifact-download-url', signingRequest.signedArtifactLink);
        core.info(`Signed artifact url ${signingRequest.signedArtifactLink}`);
        const response = await axios.get(signingRequest.signedArtifactLink, {
            responseType: 'stream',
            headers: {
                Authorization: 'Bearer ' + this.signPathToken
            }
        });

        const targetDirectory = this.resolveOrCreateDirectory(this.outputArtifactDirectory);

        core.info(`The signed artifact is being downloaded from SignPath and will be saved to ${targetDirectory}`);


        const tmpDir = fs.mkdtempSync(`${os.tmpdir()}${path.sep}`);
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

        try
        {
            core.debug(`Extracting the signed artifact from ${tmpZipFile} to ${targetDirectory}`);
            // unzip temp ZIP file to the targetDirectory
            const zip = new nodeStreamZip.async({ file: tmpZipFile });
            await zip.extract(null, targetDirectory);
            core.debug(`The signed artifact has been extracted to ${targetDirectory}`);
        }
        finally {

            core.debug(`Deleting temp directory ${tmpDir}`);
            fs.rmSync(tmpZipFile);
            fs.rmSync(tmpDir, { recursive: true });
        }

        core.info(`The signed artifact has been successfully downloaded from SignPath and extracted to ${targetDirectory}`);
    }

    resolveOrCreateDirectory(relativePath:string): string {
        const absolutePath = path.join(process.env.GITHUB_WORKSPACE as string, relativePath)
        if (!fs.existsSync(absolutePath)) {
            core.info(`Directory "${absolutePath}" does not exist and will be created`);
            fs.mkdirSync(absolutePath, { recursive: true });
        }
        return absolutePath;
    }
}
