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

function setProgress(value, max) {
	const bar = document.getElementById('progressBar');
	if (!bar) return;
	bar.style.display = 'block';
	bar.max = max;
	bar.value = value;
}

function hideProgress() {
	const bar = document.getElementById('progressBar');
	if (bar) setTimeout(() => { bar.style.display = 'none'; }, 100);
}


async function planExtraction(items, overwrite, addLoraTags, stripVersion, onProgress) {
	// Read files and plan changes without saving anything
	const plans = [];

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (onProgress) onProgress(i + 1, items.length);

		if (!overwrite && item.annotation && !addLoraTags) continue;

		try {
			const rawMetadata = await fileReader.loadFile(item.filePath);
			if (!rawMetadata) {
				writeLog(t('logWindow.noMetadata', { name: item.name }));
				continue;
			}

			const { annotation, tags, pluginTags } = metadataParser.getFormattedMetadata(rawMetadata, stripVersion);
			if (!annotation && pluginTags.length === 0) {
				writeLog(t('logWindow.unsupportedFormat', { name: item.name }));
				continue;
			}

			const oldAnnotation = item.annotation || '';
			plans.push({
				id: item.id,
				name: item.name,
				annotation,
				tags,
				pluginTags,
				oldAnnotation,
				replacesAnnotation: overwrite && annotation !== '' &&
					oldAnnotation !== '' && oldAnnotation !== annotation,
			});
		} catch (error) {
			writeLog(t('logWindow.failedExtraction', { name: item.name, error: error.message }));
		}
	}
	return plans;
}

async function applyExtraction(plans, overwrite, addLoraTags, onProgress) {
	// write the planned changes, each item is re-checked right before saving
	let numModified = 0;

	for (let i = 0; i < plans.length; i++) {
		const plan = plans[i];
		if (onProgress) onProgress(i + 1, plans.length);

		try {
			const [item] = await eagle.item.getByIds([plan.id]);
			if (!item) continue;

			const currentAnnotation = item.annotation || '';
			if (currentAnnotation !== plan.oldAnnotation) {
				writeLog(t('logWindow.annotationChanged', { name: item.name }));
				continue;
			}

			let modified = false;

			if (plan.annotation !== '' && (overwrite || !currentAnnotation) &&
				currentAnnotation !== plan.annotation) {
				item.annotation = plan.annotation;
				modified = true;
			}

			if (plan.tags.length > 0 && addLoraTags) {
				const currentTags = item.tags || [];
				const ownedTags = new Set(plan.pluginTags.map(tag => tag.toLowerCase()));
				const baseTags = overwrite
					? currentTags.filter(tag => !ownedTags.has(tag.toLowerCase()))
					: currentTags;
				const newTags = [...new Set([...baseTags, ...plan.tags])];

				if (currentTags.length !== newTags.length ||
					!currentTags.every((tag, j) => tag === newTags[j])) {
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
			writeLog(t('logWindow.failedExtraction', { name: plan.name, error: error.message }));
		}
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
		extractBtn.addEventListener('click', async () => {
			if (isProcessing) return;
			isProcessing = true;
			extractBtn.disabled = true;

			try {
				const items = await eagle.item.getSelected();
				if (items.length === 0) return;

				const overwrite = chkOverwrite.checked;
				const loraTags = chkLoras.checked;
				const stripVersion = chkStripVersion.checked;

				const plans = await planExtraction(items, overwrite, loraTags, stripVersion, setProgress);

				const toReplace = plans.filter(p => p.replacesAnnotation).length;
				if (toReplace > 0) {
					const result = await eagle.dialog.showMessageBox({
						type: 'warning',
						title: t('confirmOverwrite.title'),
						message: t('confirmOverwrite.message', { count: toReplace }),
						detail: t('confirmOverwrite.detail'),
						buttons: [t('confirmOverwrite.cancel'), t('confirmOverwrite.confirm')],
					});
					if (result.response !== 1) return;
				}

				const numModified = await applyExtraction(plans, overwrite, loraTags, setProgress);

				if (items.length > 1) {
					writeLog(t('logWindow.batchExtraction',
						{ successCount: numModified, skippedCount: items.length - numModified }));
				}
			} finally {
				hideProgress();
				isProcessing = false;
				extractBtn.disabled = false;
			}
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

				const plans = await planExtraction(fullItems, false, settings.addLoraTags, settings.stripVersion);
				const numModified = await applyExtraction(plans, false, settings.addLoraTags);
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

