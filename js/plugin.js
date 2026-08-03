const path = require('path');

const fileReader = require(path.join(__dirname, 'js', 'file_reader'));
const metadataParser = require(path.join(__dirname, 'js', 'metadata_parser'));

const POLL_INTERVAL = 2000;

const MAX_LOG_LINES = 500;
const logLines = [];

let isInitialized = false;
let isProcessing = false;
let knownItems = new Map();

const SETTINGS_KEY = 'sd-prompt-extractor.settings';

const t = (key, params) => i18next.t(key, { ...params, interpolation: { escapeValue: false } });

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

function applyTranslations(root = document) {
	root.querySelectorAll('[data-i18n]').forEach(el => {
		el.textContent = i18next.t(el.dataset.i18n);
	});
	root.querySelectorAll('[data-i18n-title]').forEach(el => {
		el.title = i18next.t(el.dataset.i18nTitle);
	});
}

function writeLog(message) {
	console.log(message);
	logLines.push(message);
	if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
	const logWindow = document.getElementById('logWindow');
	if (!logWindow) return;
	logWindow.textContent = logLines.join('\n');
	logWindow.scrollTop = logWindow.scrollHeight;
}


async function extractMetadata(items, overwrite = false, addLoraTags = true, stripVersion = true, isManual = false) {
	const progressBar = document.getElementById('progressBar');
	let numModified = 0;

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
				writeLog(t('logWindow.noMetadata', { name: item.name }));
				if (isManual && progressBar) progressBar.value = i + 1;
				continue;
			}

			const { annotation, tags, pluginTags } = metadataParser.getFormattedMetadata(rawMetadata, stripVersion);
			if (!annotation && pluginTags.length === 0) {
				writeLog(t('logWindow.unsupportedFormat', { name: item.name }));
				if (isManual && progressBar) progressBar.value = i + 1;
				continue;
			}

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
				numModified += 1;
				writeLog(t('logWindow.successfulExtraction', { name: item.name }));
			}

		} catch (error) {
			writeLog(t('logWindow.failedExtraction', { name: item.name, error: error.message }));
		}
		if (isManual && progressBar) progressBar.value = i + 1;
	}

	if (isManual && progressBar) {
		setTimeout(() => { progressBar.style.display = 'none'; }, 100);
	}
	return numModified;
}

eagle.onPluginCreate((plugin) => {
	const progressBar = document.getElementById('progressBar');
	const extractBtn = document.getElementById('extractBtn');
	const chkOverwrite = document.getElementById('chkOverwrite');
	const chkLoras = document.getElementById('chkLoras');
	const chkStripVersion = document.getElementById('chkStripVersion');

	let selectedItems = [];

	fileReader.setLogger((key, params) => writeLog(i18next.t(key, params)));
	applyTranslations();
	let settings = loadSettings();
	if (chkOverwrite) chkOverwrite.checked = settings.overwrite;
	if (chkLoras) chkLoras.checked = settings.addLoraTags;
	if (chkStripVersion) {
		chkStripVersion.checked = settings.stripVersion;
		chkStripVersion.disabled = !settings.addLoraTags;
	}
	[chkOverwrite, chkLoras, chkStripVersion].forEach(el => {
		if (!el) return;
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
				statusDiv.textContent = i18next.t('ui.selectedCount', { count: selectedItems.length });
				if (extractBtn) extractBtn.disabled = false;
			} else {
				statusDiv.textContent = i18next.t('ui.selectedNone');
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

			const numModified = await extractMetadata(selectedItems, overwrite, loraTags, stripVersion, true);

			if (selectedItems.length > 1) {
				writeLog(t('logWindow.batchExtraction',
					{ successCount: numModified, skippedCount: selectedItems.length - numModified }));
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
				writeLog(t('logWindow.initialized', {
					count: knownItems.size
				}));
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

				writeLog(t('logWindow.processingAutoExtract', { count: idsToProcess.length }));

				let fullItems = await eagle.item.getByIds(idsToProcess);

				const numModified = await extractMetadata(fullItems, settings.overwrite, settings.addLoraTags, settings.stripVersion, false);
				if (idsToProcess.length > 1) {
					writeLog(t('logWindow.batchExtraction', {
						successCount: numModified,
						skippedCount: fullItems.length - numModified
					}));
				}
			}
		} catch (error) {
			writeLog(t('logWindow.pollingError', { error: error.message }));
		} finally {
			isProcessing = false;
		}
	}, POLL_INTERVAL);

	eagle.onLibraryChanged(() => {
		isInitialized = false;
		knownItems.clear();
		pendingIds.clear();
		writeLog(t('logWindow.librarySwitch'));
	});
});

