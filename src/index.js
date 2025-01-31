import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import fs from 'fs/promises';
import BaseStorage from 'ghost-storage-base';
import path from 'path';
import { URL } from 'url';
import * as utils from './utils';

const ExtendedOctokit = Octokit.plugin(retry, throttling);
const RAW_GITHUB_URL = 'https://raw.githubusercontent.com';

class GitHubStorage extends BaseStorage {
    owner;
    repo;
    branch;
    baseUrl;
    destination;
    useRelativeUrls;
    client;

    constructor(config) {
        super();
        
        const {
            branch = 'master',
            destination = '/',
            owner,
            repo,
            baseUrl = '',
            useRelativeUrls = false,
            token = process.env.GHOST_STORAGE_GITHUB_TOKEN || config.token
        } = config;

        // Required config
        this.owner = process.env.GHOST_STORAGE_GITHUB_OWNER || owner;
        this.repo = process.env.GHOST_STORAGE_GITHUB_REPO || repo;
        this.branch = process.env.GHOST_STORAGE_GITHUB_BRANCH || branch;

        // Optional config
        const computedBaseUrl = utils.removeTrailingSlashes(process.env.GHOST_STORAGE_GITHUB_BASE_URL || baseUrl);
        this.baseUrl = utils.isValidURL(computedBaseUrl)
            ? computedBaseUrl
            : `${RAW_GITHUB_URL}/${this.owner}/${this.repo}/${this.branch}`;

        this.destination = process.env.GHOST_STORAGE_GITHUB_DESTINATION || destination;
        this.useRelativeUrls = process.env.GHOST_STORAGE_GITHUB_USE_RELATIVE_URLS === 'true' || useRelativeUrls;

        this.client = new ExtendedOctokit({
            auth: token,
            throttle: {
                onRateLimit: (retryAfter, options) => {
                    console.warn(`Request quota exhausted for ${options.method} ${options.url}`);
                    return options.request.retryCount < 3; // Retry up to 3 times
                },
                onAbuseLimit: (retryAfter, options) => {
                    console.warn(`Abuse detected for ${options.method} ${options.url}`);
                }
            }
        });
    }

    async exists(filename, targetDir) {
        const dir = targetDir || this.getTargetDir();
        const filepath = this.getFilepath(path.join(dir, filename));

        try {
            await this.client.repos.getContent({
                method: 'HEAD',
                owner: this.owner,
                repo: this.repo,
                ref: this.branch,
                path: filepath
            });
            return true;
        } catch (e) {
            if (e.status === 404) return false;
            throw e;
        }
    }

    async read(options) {
        return new Promise((resolve, reject) => {
            const req = utils.getProtocolAdapter(options.path).get(options.path, res => {
                const data = [];
                res.on('data', chunk => data.push(chunk));
                res.on('end', () => resolve(Buffer.concat(data)));
            });
            req.on('error', reject);
        });
    }

    async save(file, targetDir) {
        const dir = targetDir || this.getTargetDir();
        
        try {
            const filename = await this.getUniqueFileName(file, dir);
            const data = await fs.readFile(file.path, 'base64'); // GitHub API requires base64 encoding
            
            const res = await this.client.repos.createOrUpdateFileContents({
                owner: this.owner,
                repo: this.repo,
                branch: this.branch,
                message: `Create ${filename}`,
                path: this.getFilepath(filename),
                content: data
            });

            return this.useRelativeUrls ? `/${res.data.content.path}` : this.getUrl(res.data.content.path);
        } catch (e) {
            console.error(`Failed to save file ${file.name}:`, e);
            throw e; // Rethrow to ensure proper error handling
        }
    }

    serve() {
        return (req, res, next) => next(); // No need to serve since URLs are returned
    }

    getUrl(filepath) {
        return new URL(filepath, this.baseUrl).toString();
    }

    getFilepath(filename) {
        return utils.removeLeadingSlashes(path.join(this.destination, filename));
    }

    delete() {
        return Promise.reject(new Error('Not implemented'));
    }
}

export default GitHubStorage;