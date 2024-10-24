import { exit } from 'process';
import { join, resolve } from 'path';
import { getPackageManager } from 'package-manager-manager';
import type { CliOptions } from '../cli';
import { cliError, cliLog, cliSuccess, cliWarn } from '../cli';
import { getVercelConfig } from './getVercelConfig';
import { buildWorkerFile } from './buildWorkerFile';
import { buildVercelOutput } from './buildVercelOutput';
import { buildMetadataFiles } from './buildMetadataFiles';
import { validateDir } from '../utils';
import {
	getVercelStaticAssets,
	processVercelOutput,
	processOutputDir,
} from './processVercelOutput';
import { printBuildSummary, writeBuildInfo } from './buildSummary';
import type { ProcessedVercelFunctions } from './processVercelFunctions';
import { processVercelFunctions } from './processVercelFunctions';

/**
 * Builds the _worker.js with static assets implementing the Next.js application
 *
 * @param options options for the build
 */
export async function buildApplication({
	skipBuild,
	disableChunksDedup,
	disableWorkerMinification,
	watch,
	outdir: outputDir,
	customEntrypoint,
}: Pick<
	CliOptions,
	| 'skipBuild'
	| 'disableChunksDedup'
	| 'disableWorkerMinification'
	| 'watch'
	| 'outdir'
	| 'customEntrypoint'
>) {
	const pm = await getPackageManager();

	if (!pm) {
		throw new Error('Error: Could not detect current package manager in use');
	}

	if (pm.projectPackageManager && pm.name !== pm.projectPackageManager) {
		cliWarn(
			`The project is set up for ${pm.projectPackageManager} but it is currently being run` +
				` via ${pm.name} this might lead to build errors, please be sure to use the same package manager` +
				` your project uses when running @fleek-platform/next-on-fleek`,
			{ spaced: true },
		);
	}

	let buildSuccess = true;
	if (!skipBuild) {
		try {
			await buildVercelOutput(pm);
		} catch {
			const execStr = await pm.getRunExec('vercel', {
				args: ['build'],
				download: 'prefer-if-needed',
			});
			cliError(
				`
					The Vercel build ${
						execStr ? `(\`${execStr}\`) ` : ''
					}command failed. For more details see the Vercel logs above.
					If you need help solving the issue, refer to the Vercel or Next.js documentation or their repositories.
				`,
				{ spaced: true },
			);
			buildSuccess = false;
		}
	}

	if (!buildSuccess) {
		if (!watch) exit(1);
		return;
	}

	const buildStartTime = Date.now();

	await prepareAndBuildWorker(outputDir, {
		disableChunksDedup,
		disableWorkerMinification,
		customEntrypoint,
	});

	const totalBuildTime = ((Date.now() - buildStartTime) / 1000).toFixed(2);
	cliLog(`Build completed in ${totalBuildTime.toLocaleString()}s`);
}

async function prepareAndBuildWorker(
	outputDir: string,
	{
		disableChunksDedup,
		disableWorkerMinification,
		customEntrypoint,
	}: Pick<
		CliOptions,
		'disableChunksDedup' | 'disableWorkerMinification' | 'customEntrypoint'
	>,
): Promise<void> {
	let vercelConfig: VercelConfig;
	try {
		vercelConfig = await getVercelConfig();
	} catch (e) {
		if (e instanceof Error) {
			cliError(e.message, { showReport: true });
		}
		exit(1);
	}

	const staticAssets = await getVercelStaticAssets();

	await processOutputDir(outputDir, staticAssets);

	let processedFunctions: ProcessedVercelFunctions | undefined;

	const functionsDir = resolve('.vercel', 'output', 'functions');
	const workerJsDir = join(outputDir, '_worker.js');
	const nopDistDir = join(workerJsDir, '__next-on-pages-dist__');
	const templatesDir = join(__dirname, '..', 'templates');

	if (!(await validateDir(functionsDir))) {
		cliLog(
			'No functions detected (no functions directory generated by Vercel).',
		);
	} else {
		processedFunctions = await processVercelFunctions({
			functionsDir,
			outputDir,
			workerJsDir,
			nopDistDir,
			disableChunksDedup,
			vercelConfig,
		});
	}

	const processedVercelOutput = await processVercelOutput(
		vercelConfig,
		staticAssets,
		processedFunctions?.collectedFunctions?.prerenderedFunctions,
		processedFunctions?.collectedFunctions?.edgeFunctions,
	);

	const outputtedWorkerPath = await buildWorkerFile(processedVercelOutput, {
		outputDir,
		workerJsDir,
		nopDistDir,
		templatesDir,
		customEntrypoint,
		minify: !disableWorkerMinification,
	});

	await buildMetadataFiles(outputDir, { staticAssets });

	printBuildSummary(staticAssets, processedVercelOutput, processedFunctions);

	await writeBuildInfo(
		{ outputDir: workerJsDir, functionsDir },
		staticAssets,
		processedVercelOutput,
		processedFunctions,
	);

	cliSuccess(`Generated '${outputtedWorkerPath}'.`);
}
