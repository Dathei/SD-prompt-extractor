const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');

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

	let itemsToProcess = {};
	for (let item of items) {
		if (!overwrite && item.annotation) continue;
		itemsToProcess[item.id] = path.dirname(item.metadataFilePath);
	}

	const processCount = Object.keys(itemsToProcess).length;
	if (processCount === 0) {
		writeLog("All items already have annotations.");
		if (isManual && progressBar) progressBar.style.display = 'none';
		return;
	}

	const tempJsonPath = path.join(__dirname, "temp_bulk_process.json");
	fs.writeFileSync(tempJsonPath, JSON.stringify(itemsToProcess), 'utf8');

	let command = `"${pythonScript}" api --bulk "${tempJsonPath}"`;
	if (stripVersion) command += " --strip_version";

	try {
		// maxBuffer is increased just in case the JSON string for many files gets large
		const { stdout } = await execPromise(command, { maxBuffer: 1024 * 1024 * 10 });

		if (stdout) {
			let data = JSON.parse(stdout);

			writeLog(`Python script finished extracting. Updating Eagle UI...`);

			let successCount = 0;
			for (let i = 0; i < items.length; i++) {
				let item = items[i];
				let result = data[item.id];

				if (result) {
					let annotation = result.annotation || "";
					let tags = result.tags || [];
					let modified = false;

					if (!item.annotation && annotation !== "") {
						item.annotation = annotation;
						modified = true;
					}

					if (tags.length > 0 && addLoraTags) {
						let currentTags = item.tags || [];
						if (overwrite) {
							// Only remove existing tags that start with "lora:"
							let preservedTags = currentTags.filter(t => !t.toLowerCase().startsWith("lora:"));
							item.tags = [...new Set([...preservedTags, ...tags])];
						} else {
							item.tags = [...new Set([...currentTags, ...tags])];
						}

						modified = true;
					}

					if (modified) {
						await item.save();
						successCount++;
					}
				}

				if (isManual && progressBar) progressBar.value = i + 1;
			}
			if (successCount === 0) {
				writeLog("No files were modified.");
			} else if (successCount === 1) {
				writeLog(`Finished updating ${successCount} file.`);
			}  else {
				writeLog(`Finished updating ${successCount} files.`);
			}
		}
	} catch (error) {
		writeLog(`Extraction failed: ${error.message}`);
	} finally {
		// Clean up the temp file
		if (fs.existsSync(tempJsonPath)) {
			fs.unlinkSync(tempJsonPath);
		}
	}

	if (isManual && progressBar) {
		setTimeout(() => { progressBar.style.display = 'none'; }, 100);
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
				if (modifiedIds.length === 1) {
					writeLog(`Found ${modifiedIds.length} new item.`);
				} else {
					writeLog(`Found ${modifiedIds.length} new items.`);
				}
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

