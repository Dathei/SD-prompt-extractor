const { exec } = require('child_process');
const util = require('util');
const path = require('path');

const execPromise = util.promisify(exec);

// const pythonScript = path.join(__dirname, "./prompt_extractor.py");
const pythonScript = path.join(__dirname, "dist", "prompt_extractor.exe");
const POLL_INTERVAL = 1000;

// let lastSyncTime = Date.now();
let isInitialized = false;
let isProcessing = false;
let knownItems = new Map();



function writeLog(message) {
	const logWindow = document.getElementById('logWindow');
	console.log(message);
	logWindow.textContent += `${message}\n`;
	logWindow.scrollTop = logWindow.scrollHeight;
}


async function extractMetadata(items, overwrite = false, addLoraTags = true, stripVersion = true, isManual = false) {
	const progressBar = document.getElementById('progressBar');
	if (isManual && progressBar) {
		progressBar.style.display = 'block';
		progressBar.max = items.length;
		progressBar.value = 0;
	}

	for (let i = 0; i < items.length; i++) {
		let item = items[i];
		writeLog(`[${i+1}/${items.length}] Processing ${item.name}`);

		if (!overwrite && item.annotation) continue;

		const itemInfoFolder = path.dirname(item.metadataFilePath);

		// let command = `python "${pythonScript}" api --file "${itemInfoFolder}"`;
		let command = `"${pythonScript}" api --file "${itemInfoFolder}"`;

		if (stripVersion) {
			command += " --strip_version";
		}

		try {
			// console.log(`Running Python script for item ${item.id}: ${command}`);

			const { stdout, stderr } = await execPromise(command);
			if (stdout) {
				try {
					let data = JSON.parse(stdout);
					let annotation = data.annotation || "";
					let tags = data.tags || [];

					let modified = false;

					if (!item.annotation && annotation !== "") {
						item.annotation = annotation;
						modified = true;
					}
					if (tags.length > 0 && addLoraTags) {
						let currentTags = item.tags || [];
						// Prevents duplicates and deletion of custom tags
						item.tags = [...new Set([...currentTags, ...tags])];
						modified = true;
					}

					if (modified) {
						await item.save();
						console.log(`Successfully extracted data for: ${item.name}`);
					} else {
						console.log(`No new metadata for: ${item.name}`);
					}


				} catch (error) {
					writeLog(`JSON Parse failed for ${item.name}: ${error.message}`);
				}
			}
		} catch (error) {
			writeLog(`Python script failed for item ${item.name}: ${error.message}`);
		}
		if (isManual && progressBar) {
			progressBar.value = i + 1;
		}

		await new Promise(resolve => setTimeout(resolve, 10));
	}

	// Hiding progress bar after completion
	if (isManual && progressBar) {
		setTimeout(() => { progressBar.style.display = 'none'; }, 500);
	}
}

eagle.onPluginCreate((plugin) => {
	const progressBar = document.getElementById('progressBar');
	const extractBtn = document.getElementById('extractBtn');
	const chkOverwrite = document.getElementById('chkOverwrite');
	const chkLoras = document.getElementById('chkLoras');
	const chkStripVersion = document.getElementById('chkStripVersion');

	let selectedItems = [];

	if (chkLoras && chkStripVersion) {
		chkLoras.addEventListener('change', (e) => {
			chkStripVersion.disabled = !e.target.checked;
		});
	}

	setInterval(async () => {
		const statusDiv = document.getElementById('selected')
		if (statusDiv) {
			selectedItems = await eagle.item.getSelected();
			if (selectedItems.length > 0) {
				statusDiv.innerHTML = `<b>Number of selected files: ${selectedItems.length}</b>`
				if (extractBtn) extractBtn.disabled = false;
			} else {
				statusDiv.innerHTML = `<b>You have not selected any files.</b>`
				if (extractBtn) extractBtn.disabled = true;
			}

		}
	}, 1000);

	if (extractBtn) {
		extractBtn.addEventListener('click', async  () => {
			if (selectedItems.length === 0 || isProcessing) return;

			isProcessing = true;
			extractBtn.disabled = true;

			const overwrite = chkOverwrite.checked;
			const loraTags = chkLoras.checked;
			const stripVersion = chkStripVersion.checked;

			progressBar.style.display = 'block';
			progressBar.max = selectedItems.length;
			progressBar.value = 0;

			await extractMetadata(selectedItems, overwrite, loraTags, stripVersion, true);

			writeLog("All files extracted");

			isProcessing = false;
			extractBtn.disabled = false;
		});
	}

	setInterval(async () => {
		if (isProcessing) return;
		isProcessing = true;

		try {
			let allFiles = await eagle.item.getIdsWithModifiedAt();

			// This doesn't work:
			// let modifiedFiles = allFiles.filter(file => file.modifiedAt > lastSyncTime);

			if (!isInitialized) {
				allFiles.forEach(file => {
					knownItems.set(file.id, file.modifiedAt || 0)
				});
				isInitialized = true;
				writeLog(`Plugin initialized. Tracking ${knownItems.size} items.`);
				isProcessing = false;
				return;
			}

			let modifiedIds = [];

			for (let file of allFiles) {
				let prevModified = knownItems.get(file.id);
				let currModified = file.modifiedAt || 0;

				if (prevModified === undefined) {
					modifiedIds.push(file.id);
					knownItems.set(file.id, currModified);
				}
			}

			if (modifiedIds.length > 0) {
				writeLog(`Found ${modifiedIds.length} new items`);
				let fullItems = await eagle.item.getByIds(modifiedIds);

				await extractMetadata(fullItems, false, true, true, false);
			}
		} catch (error) {
			writeLog("Polling error: ", error);
		} finally {
			isProcessing = false;
		}
	}, POLL_INTERVAL);
});

// eagle.onPluginShow(() => {
// });

// eagle.onPluginRun(() => {
// });

// eagle.onPluginHide(() => {
// });

// eagle.onPluginBeforeExit((event) => {
// });

