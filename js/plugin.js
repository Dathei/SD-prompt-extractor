const path = require('path');

const fileReader = require(path.join(__dirname, 'js', 'file_reader'));
const metadataParser = require(path.join(__dirname, 'js', 'metadata_parser'));

const POLL_INTERVAL = 2000;

let isInitialized = false;
let isProcessing = false;
let knownItems = new Map();

const SETTINGS_KEY = 'sd-prompt-extractor.settings';


function loadSettings() {
	try {
		return { overwrite: false, addLoraTags: true, stripVersion: false,
				...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
	} catch (e) {
		return {overwrite: false, addLoraTags: true, stripVersion: false}
	}
}

function saveSettings(s) {
	try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}


function writeLog(message) {
	const logWindow = document.getElementById('logWindow');
	if (!logWindow) return;
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

		if (!overwrite && item.annotation && !addLoraTags) {
			if (isManual && progressBar) progressBar.value = i + 1;
			continue;
		}

		const [fresh] = await eagle.item.getByIds([item.id]);
		if (!fresh) continue;
		item = fresh;

		try {
			const filePath = item.filePath;
			const rawMetadata = await fileReader.loadFile(filePath);

			if (!rawMetadata) {
				writeLog(`No metadata found for: ${item.name}`);
				if (isManual && progressBar) progressBar.value = i + 1;
				continue;
			}

			const { annotation, tags, pluginTags } = metadataParser.getFormattedMetadata(rawMetadata, stripVersion);

			let modified = false;

			if (annotation !== "" && (overwrite || !item.annotation)) {
				if (item.annotation !== annotation) {
					item.annotation = annotation;
					modified = true;
				}
			}

			if (tags.length > 0 && addLoraTags) {
				let currentTags = item.tags || [];
				let newTags = [];

				const ownedTags = new Set(pluginTags.map(t => t.toLowerCase()));

				if (overwrite) {
					const preservedTags = currentTags.filter(t => !ownedTags.has(t.toLowerCase()));
					newTags = [...new Set([...preservedTags, ...tags])];
				} else {
					newTags = [...new Set([...currentTags, ...tags])];
				}

				if (currentTags.length !== newTags.length || !currentTags.every((t, i) => t === newTags[i])) {
					item.tags = newTags;
					modified = true;
				}
			}

			if (modified) {
				await item.save();
				writeLog(`Extracted data for: ${item.name}`);
			}

		} catch (error) {
			writeLog(`Extraction failed for: ${item.name}: ${error}`);
		}
		if (isManual && progressBar) progressBar.value = i + 1;
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

	let settings = loadSettings();
	if (chkOverwrite) chkOverwrite.checked = settings.overwrite;
	if (chkLoras) chkLoras.checked = settings.addLoraTags;
	if (chkStripVersion) {
		chkStripVersion.checked = settings.stripVersion;
		chkStripVersion.disabled = !settings.addLoraTags;
	}
	[chkOverwrite, chkLoras, chkStripVersion].forEach(el => {
		el.addEventListener('change', () => {
			settings = {
				overwrite: chkOverwrite ? chkOverwrite.checked : false,
				addLoraTags: chkLoras ? chkLoras.checked : true,
				stripVersion: chkStripVersion ? chkStripVersion.checked : true,
			};
			saveSettings(settings)
		});
	});

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

			await extractMetadata(selectedItems, overwrite, loraTags, stripVersion, true);

			if (selectedItems.length > 1) {
				writeLog(`All ${selectedItems.length} selected files extracted`);
			}

			isProcessing = false;
			extractBtn.disabled = false;
		});
	}

	let lastDetectedTime = 0;
	let pendingIds = new Set();

	setInterval(async () => {
		if (isProcessing) return;
		isProcessing = true;

		try {
			let allFiles = await eagle.item.getIdsWithModifiedAt();

			if (!isInitialized) {
				allFiles.forEach(file => {
					knownItems.set(file.id, file.modifiedAt || 0)
				});
				isInitialized = true;
				writeLog(`Plugin initialized. Tracking ${knownItems.size} items.`);
				isProcessing = false;
				return;
			}

			// Clean up deleted items
			const currentIds = new Set(allFiles.map(f => f.id));
			for (const id of knownItems.keys()) {
				if (!currentIds.has(id)) {
					knownItems.delete(id);
				}
			}

			let newItemsFound = false;

			for (let file of allFiles) {
				let prevModified = knownItems.get(file.id);
				let currModified = file.modifiedAt || 0;

				if (prevModified === undefined) {
					knownItems.set(file.id, currModified);
					pendingIds.add(file.id);
					newItemsFound = true;
				}
			}

			if (newItemsFound) {
				lastDetectedTime = Date.now();
			}

			// Letting Eagle finish importing before writing into the annotation field
			if (pendingIds.size > 0 && (Date.now() - lastDetectedTime > 3000)) {
				let idsToProcess = Array.from(pendingIds);
				pendingIds.clear();

				writeLog(`Processing batch of ${idsToProcess.length} item(s)...`);

				let fullItems = await eagle.item.getByIds(idsToProcess);

				await extractMetadata(fullItems, settings.overwrite, settings.addLoraTags, settings.stripVersion, false);
			}
		} catch (error) {
			writeLog(`Polling error: ${error}`);
		} finally {
			isProcessing = false;
		}
	}, POLL_INTERVAL);
});

