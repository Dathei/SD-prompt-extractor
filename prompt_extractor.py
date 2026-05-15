#!/usr/bin/env python3
import re
import os
import json
import math
import random
import argparse

from enum import Enum
from typing import Optional

import av
import piexif
import piexif.helper
from PIL import Image


VALID_FORMATS = ('.png', '.jpg', '.jpeg', '.mp4', '.mkv', '.webm', '.mov', '.avi')

class MetadataOption(Enum):
    ALL = "all"
    PROMPT = "prompt"
    PARAMETERS = "parameters"
    POSITIVE_PROMPT = "positive"
    NEGATIVE_PROMPT = "negative"
    STEPS = "steps"
    SAMPLER = "sampler"
    SCHEDULER = "scheduler"
    CFG = "cfg"
    SEED = "seed"
    SIZE = "size"
    MODEL = "model"

def load_file(file_path: str, verbose: bool = False) -> dict | None:
    try:
        if file_path.endswith('.png'):
            with Image.open(file_path) as img:
                if hasattr(img, 'info'):
                    metadata = img.info
                else:
                    if verbose:
                        print(f"No info attribute found in png {file_path}")
                    return None

        elif file_path.endswith('.jpg') or file_path.endswith('.jpeg'):
            img = piexif.load(file_path)
            try:
                metadata = piexif.helper.UserComment.load(img["Exif"][piexif.ExifIFD.UserComment])
            except KeyError:  # no exif data
                if verbose:
                    print(f"No metadata found in jpg {file_path}")
                return None

        elif file_path.endswith(('.mp4', '.mkv', '.webm', '.mov', '.avi')):
            try:
                with av.open(file_path) as container:
                    metadata = container.metadata
                    potential_keys = ['comment', 'COMMENT', 'prompt', 'Prompt', 'workflow', 'Workflow', 'description']
                    comment_str = None

                    for key in potential_keys:
                        if metadata.get(key):
                            comment_str = metadata.get(key)
                            break

                    if not comment_str:
                        if verbose:
                            print(f"No metadata tags found in video {file_path}")
                        return None

                    nodes = json.loads(comment_str)
                    return nodes

            except json.JSONDecodeError:
                pass
        else:
            raise ValueError("Invalid image type")

        return metadata

    except Exception as e:
        if verbose:
            print(f"Error processing {file_path}: {e}")
        return None


def extract_metadata(file_path: str, verbose: bool = False) -> dict:
    metadata = load_file(file_path, verbose)

    if not metadata:
        if verbose:
            print(f"No metadata found in {file_path}")
        return {}

    if metadata.get('parameters'):      # A1111
        return extract_a1111_metadata(metadata)

    elif metadata.get('prompt'):        # ComfyUI
        nodes = json.loads(metadata.get('prompt'))
        if isinstance(nodes, str):
            nodes = json.loads(nodes)
        return extract_comfy_metadata(nodes)

    else:
        if verbose:
            print(f"Unknown metadata type found in {file_path}")
        return {}

def extract_a1111_metadata(metadata: dict) -> dict:
    result = {
        'full_prompt': "",
        'positive': "",
        'negative': "",
        'steps': "",
        'sampler': "",
        'scheduler': "",
        'cfg': "",
        'size': "",
        'seed': "",
        'model': "",
        'loras': {}
    }

    parameters = metadata.get('parameters', '')
    if not parameters:
        return result

    result['full_prompt'] = parameters.strip()

    # Split prompts and settings
    parts = parameters.split('\nSteps: ')

    if len(parts) < 2:
        # There are no settings
        return result

    prompts_part = parts[0]
    settings_part = "Steps: " + parts[1]

    if "Negative prompt:" in prompts_part:
        pos, neg = prompts_part.split('Negative prompt:')
        result['positive'] = pos.strip()
        result['negative'] = neg.strip()
    else:
        result['positive'] = prompts_part.strip()

    def get_setting(key: str) -> str:
        match = re.search(fr"{key}:\s*([^,]+)", settings_part)
        return match.group(1).strip() if match else ""

    result['steps'] = get_setting("Steps")
    result['sampler'] = get_setting("Sampler")
    result['scheduler'] = get_setting("Schedule type")
    result['cfg'] = get_setting("CFG scale")
    result['seed'] = get_setting("Seed")
    result['size'] = get_setting("Size")
    result['model'] = get_setting("Model")

    lora_matches = re.findall(r"<lora:([^:]+):([^>]+)>", parameters)
    result['loras'] = {name: strength for name, strength in lora_matches}

    return result


def _resolve_linked_node(link: list, nodes: dict, target_param: str = None, visited: set = None):
    if visited is None:
        visited = set()

    if not isinstance(link, list) or len(link) < 1:
        return link

    target_id = str(link[0])

    if target_id in visited:
        return None
    visited.add(target_id)

    target_node = nodes.get(target_id, {})
    inputs = target_node.get('inputs', {})
    class_type = inputs.get('class', '').lower()

    try:
        # Handle explicit value/primitives
        if 'value' in inputs or 'primitive' in class_type:
            value = inputs.get('value')
            return _resolve_linked_node(value, nodes, target_param, visited) if isinstance(value, list) else value

        # Handle switch routes
        if 'switch' in inputs or 'switch' in class_type:
            switch_value = inputs.get('switch')
            if isinstance(switch_value, list):
                switch_value = _resolve_linked_node(switch_value, nodes, 'switch', visited)

            if switch_value is True and 'on_true' in inputs:
                return _resolve_linked_node(inputs['on_true'], nodes, target_param, visited)
            elif switch_value is False and 'on_false' in inputs:
                return _resolve_linked_node(inputs['on_false'], nodes, target_param, visited)

        # Handle resolution nodes
        if target_param in ['width', 'height']:
            if 'megapixels' in inputs and any(k in inputs for k in ['aspect_ratio', 'ratio']):
                megapixels = inputs.get('megapixels')
                if isinstance(megapixels, list):
                    megapixels = _resolve_linked_node(megapixels, nodes, 'megapixels', visited)

                aspect_ratio = inputs.get('aspect_ratio') or inputs.get('ratio')
                if isinstance(aspect_ratio, list):
                    aspect_ratio = _resolve_linked_node(aspect_ratio, nodes, 'aspect_ratio', visited)

                w_r, h_r = parse_aspect_ratio(aspect_ratio)
                w, h = calculate_resolution(w_r, h_r, float(megapixels))
                return w if target_param == 'width' else h

        if target_param and target_param in inputs:
            value = inputs.get(target_param)
            return _resolve_linked_node(value, nodes, target_param, visited)

        # Special case when CreateCFGScheduleFloatList is used
        if target_param == 'cfg':
            start = inputs.get('cfg_scale_start')
            end = inputs.get('cfg_scale_end')
            if start is not None and end is not None:
                if isinstance(start, list):
                    start = _resolve_linked_node(start, nodes, target_param, visited)
                if isinstance(end, list):
                    end = _resolve_linked_node(end, nodes, target_param, visited)

                try:
                    start = float(start)
                    end = float(end)

                    if start == end:
                        return start
                    return f"{start} -> {end}"  # probably incompatible with A1111

                except (ValueError, TypeError):
                    return start

        aliases = {
            'sampler': ['sampler_name', 'sampler'],
            'steps': ['steps', 'sigmas'],
            'seed': ['seed', 'noise', 'noise_seed'],
            'cfg': ['cfg', 'guider', 'guidance'],
        }

        for alias in aliases.get(target_param, []):
            if alias in inputs:
                value = inputs[alias]
                return _resolve_linked_node(value, nodes, target_param, visited) if isinstance(value, list) else value

    except Exception as e:
        print(f"Error resolving {target_param} on node {target_id}: {e}")

    return None


def get_active_graph(nodes: dict) -> dict:
    active_ids = set()

    # Nodes that are referenced by other nodes
    referenced = set()
    for node_id, data in nodes.items():
        for v in data.get('inputs', {}).values():
            if isinstance(v, list):
                referenced.add(str(v[0]))

    # Nodes that weren't referenced e.g., SaveImage, PreviewImage
    sinks = [n_id for n_id in nodes if n_id not in referenced]

    # Helper to trace nodes backwards from sinks
    def trace(nid: str):
        if nid in active_ids:
            return
        active_ids.add(nid)

        node = nodes.get(nid)
        if not node:
            return

        inputs = node.get('inputs', {})
        if 'switch' in inputs and ('on_true' in inputs or 'on_false' in inputs):
            switch_link = inputs['switch']
            if isinstance(switch_link, list):
                trace(str(switch_link[0]))

            switch_val = _resolve_linked_node(switch_link, nodes, target_param='switch')
            active_path = 'on_true' if switch_val else 'on_false'
            if active_path in inputs and isinstance(inputs[active_path], list):
                trace(str(inputs[active_path][0]))
        else:
            # Normal nodes
            for key, val in inputs.items():
                if isinstance(val, list) and len(val) >= 1:
                    trace(str(val[0]))

    for sink in sinks:
        trace(str(sink))

    return {k: v for k, v in nodes.items() if k in active_ids}


def parse_aspect_ratio(aspect_ratio: str) -> tuple[float, float]:
    match = re.search(r"(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)", aspect_ratio)
    if match:
        return float(match.group(1)), float(match.group(2))
    return 0.0, 0.0

def calculate_resolution(ratio_w: float, ratio_h: float, megapixels: float) -> tuple[int, int]:
    base = 1024 * 1024
    area = megapixels * base
    ratio = ratio_w / ratio_h
    h = math.sqrt(area / ratio)
    w = h * ratio
    w = round(w / 8) * 8
    h = round(h / 8) * 8
    return int(w), int(h)

def extract_comfy_metadata(nodes: dict) -> dict:
    if not nodes:
        return {}

    nodes = get_active_graph(nodes)

    active_loras = {}  # name: strength
    result = {
        'positive': "",
        'negative': "",
        'steps': "",
        'sampler': "",
        'scheduler': "",
        'cfg': "",
        'size': "",
        'seed': "",
        'model': "",
        'loras': active_loras
    }

    potential_prompts = []
    ksamplers = []
    empty_negative = False

    #print(nodes)

    for node_id, data in nodes.items():
        node_type = data['class_type'].lower()

        # Look for positive/negative prompt
        if "textencode" in node_type or node_type in ["easy positive", "easy negative", "wildcard processor"]:
            extracted = extract_comfy_prompt(data)

            if extracted['positive'] and not result.get('positive'):
                result['positive'] = extracted['positive']

            if extracted.get('negative') is not None:
                if extracted['negative'] == "":
                    empty_negative = True
                elif not result.get('negative'):
                    result['negative'] = extracted['negative']

            if extracted['text']:
                title = data.get('_meta', {}).get('title', '').lower()
                text_val = extracted['text']

                # If the title contains "positive" or "negative" it can easily be categorized
                if "positive" in title and not result.get('positive'):
                    result['positive'] = text_val
                elif "negative" in title:
                    if text_val == "":
                        empty_negative = True
                    elif not result.get('negative'):
                        result['negative'] = text_val
                else:
                    if text_val:
                        potential_prompts.append(text_val)

        # Look for Sampler for settings
        if "sampler" in node_type:
            link = data['inputs'].get('steps') or data['inputs'].get('sigmas')
            if isinstance(link, list):
                steps = _resolve_linked_node(link, nodes, 'steps')
                data['inputs']['steps'] = steps
            ksamplers.append(data['inputs'])

        # Look for Guidance, which is the CFG replacement for Flux for example
        if "guid" in node_type:
            guidance = data['inputs'].get('guidance')
            if isinstance(guidance, list):
                guidance = _resolve_linked_node(guidance, nodes, 'guidance')
            result['cfg'] = guidance

        # Look for the model
        model_keywords = ['checkpoint', 'unet', 'gguf', 'model']
        ignore_keywords = ['vae', 'image', 'video', 'lora']
        if not any(ignore in node_type for ignore in ignore_keywords):
            if "load" in node_type and any(name in node_type for name in model_keywords):
                # Just using the first viable result for now
                if not result.get('model'):
                    model = next((v for k, v in data['inputs'].items() if "name" in k or "model" in k), None)
                    if model:
                        result['model'] = model.split('\\')[-1]

        # Look for EmptyLatent to get the resolution
        is_empty_latent = "latent" in node_type and "empty" in node_type
        is_resizer = any(kw in node_type for kw in ["imagetovideolatent", "imageresize"])
        if (is_empty_latent or is_resizer) and not result['size']:
            width = data['inputs'].get('width')
            if isinstance(width, list):
                width = _resolve_linked_node(width, nodes, target_param='width')

            height = data['inputs'].get('height')
            if isinstance(height, list):
                height = _resolve_linked_node(height, nodes, target_param='height')

            if width and height:
                result['size'] = f"{width}x{height}"

        # Look for Loras
        if "lora" in node_type:
            lora_name = data.get('inputs', {}).get('lora_name')
            lora_strength = data.get('inputs', {}).get('strength_model')
            if lora_name and float(lora_strength) != 0.0:
                lora_name = lora_name.split('\\')[-1]
                lora_name = lora_name.split('.')[0]
                active_loras[lora_name] = lora_strength

            elif data.get('inputs', {}).get('lora_1'):
                for k, v in data['inputs'].items():
                    if k.startswith('lora'):
                        lora_name = v.get('lora')
                        if lora_name:
                            lora_name = lora_name.split('\\')[-1]
                            lora_name = lora_name.split('.')[0]
                            lora_strength = v.get('strength')
                            is_enabled = v.get('on')
                            if is_enabled:
                                active_loras[lora_name] = lora_strength

    # The longest text probably is the positive prompt. If found already, it's probably the negative prompt
    potential_prompts = sorted(potential_prompts, key=lambda x: len(x), reverse=True)
    if potential_prompts:
        if not result.get('positive'):
            result['positive'] = potential_prompts.pop(0)
        if not result.get('negative') and not empty_negative and potential_prompts:
            result['negative'] = potential_prompts.pop(0)

    # The Ksampler with the highest number of steps probably is the main Ksampler, refiners/upscale typically use fewer steps
    ksamplers = sorted(ksamplers, key=lambda x: x.get('steps', 0), reverse=True)
    if ksamplers:
        result['steps'] = ksamplers[0].get('steps')
        result['sampler'] = ksamplers[0].get('sampler') or ksamplers[0].get('sampler_name')
        if isinstance(result['sampler'], list) and len(result['sampler']) == 2:
            result['sampler'] = _resolve_linked_node(result['sampler'], nodes, 'sampler')
        result['scheduler'] = ksamplers[0].get('scheduler')
        if not result['cfg']:
            result['cfg'] = ksamplers[0].get('cfg')
            if isinstance(result['cfg'], list) and len(result['cfg']) == 2:
                result['cfg'] = _resolve_linked_node(result['cfg'], nodes, 'cfg')
        result['seed'] = ksamplers[0].get('seed') or ksamplers[0].get('noise')
        if isinstance(result['seed'], list):
            result['seed'] = _resolve_linked_node(result['seed'], nodes, 'seed')

    return result


def extract_comfy_prompt(node_data: dict) -> dict:
    inputs = node_data.get('inputs', {})
    extracted: dict[str, str | list | None] = {'positive': None, 'negative': None, 'text': None}

    def get_str(key):  # Helper to ignore lists and safely strip
        val = inputs.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        return ""

    text = get_str('text')
    if text:
        extracted['text'] = text
        return extracted

    # CLIPTextEncodeSDXL
    text_g = get_str('text_g')
    text_l = get_str('text_l')
    if text_g or text_l:
        extracted['text'] = text_g if text_g == text_l else f"{text_g} {text_l}".strip()
        return extracted

    # CLIPTextEncodeFlux
    clip_l = get_str('clip_l')
    t5xxl = get_str('t5xxl')
    if clip_l or t5xxl:
        extracted['text'] = clip_l if clip_l == t5xxl else f"{clip_l} {t5xxl}".strip()
        return extracted

    # easy positive/easy negative
    positive = get_str('positive')
    if positive:
        extracted['positive'] = positive
        return extracted
    negative = get_str('negative')
    if negative:
        extracted['negative'] = negative
        return extracted

    # WAN (dual prompt node)
    pos_prompt = get_str('positive_prompt')
    neg_prompt = get_str('negative_prompt')
    if pos_prompt or neg_prompt:
        extracted['positive'] = pos_prompt or None
        extracted['negative'] = neg_prompt or None
        return extracted

    # TextEncodeQwenImageEdit & TextEncodeZImageOmni & probably others
    prompt = get_str('prompt')
    if prompt:
        extracted['text'] = prompt
        return extracted

    return extracted


def format_comfy_parameters(parameters: dict) -> str:
    parts = []

    positive = parameters.get('positive')
    if positive:
        parts.append(str(positive).strip())

    loras = parameters.get('loras', {})
    if loras:
        lora_lines = ["Loras:"]
        for name, strength in loras.items():
            try:
                lora_lines.append(f"{name}: {float(strength):.2f}")
            except (ValueError, TypeError):     # in case casting to float fails, which is needed for .2f
                lora_lines.append(f"{name}: {strength}")
        parts.append("\n".join(lora_lines))

    negative = parameters.get('negative')
    if negative:
        parts.append(f"Negative prompt: {str(negative).strip()}")

    params = []

    if parameters.get('steps'):
        params.append(f"Steps: {parameters['steps']}")

    if parameters.get('sampler'):
        params.append(f"Sampler: {str(parameters['sampler']).split("/")[-1].capitalize()}")

    if parameters.get('scheduler'):
        params.append(f"Scheduler: {str(parameters['scheduler']).capitalize()}")

    if parameters.get('cfg'):
        params.append(f"CFG scale: {parameters['cfg']}")

    if parameters.get('seed'):
        params.append(f"Seed: {parameters['seed']}")

    if parameters.get('size'):
        params.append(f"Size: {parameters['size']}")

    if parameters.get('model'):
        params.append(f"Model: {str(parameters['model']).strip()}")

    if params:
        parts.append(", ".join(params))

    return "\n\n".join(parts)


def process_string(s: str) -> str:
    s = re.sub(r"<.*?>", "", s)  # remove lora tags
    s = re.sub(r"\(", "", s)  # remove opening parentheses
    s = re.sub(r":[^)]*", "", s)  # remove emphasis
    s = re.sub(r"\)", "", s)  # remove closing parentheses
    s = re.sub(r"\n", ", ", s)  # remove newlines
    s = re.sub(r"\s*,", ",", s)  # remove leading spaces before commas
    s = re.sub(r"(,)(\w)", r", \1", s)  # Add space after comma
    #s = re.sub(r",\s*,", ",", s)  # remove empty commas
    s = re.sub(r"\s+", " ", s)  # remove extra spaces
    return s.strip()


def add_loras_as_tags(lora_dict: dict, strip_version: bool = False) -> list:
    tags = []
    version_pattern = r"(?:[_-]|(?<=[a-zA-Z]))(?:[vV]\d+(?:[.-]\d+)?|0+\d+)(?=[_-]|$)|[_-]\d+(?:[.-]\d+)?$"

    for lora_name in lora_dict.keys():
        if strip_version:
            lora_name = re.sub(version_pattern, "", lora_name)
            # Cleanup double underscores/dashes left behind in the middle
            lora_name = re.sub(r"_{2,}|-{2,}", "_", lora_name)
            # Cleanup any dangling underscores/dashes at the very end
            lora_name = lora_name.strip("_-")
        tags.append(f"lora: {lora_name}")

    return tags


def get_formatted_metadata(file_path: str, verbose: bool = False):
    try:
        parameters = extract_metadata(file_path)

        if parameters is None:
            return None, None

        prompt = parameters.get('full_prompt')                  # A1111 prompt
        if not prompt:
            prompt = format_comfy_parameters(parameters)        # ComfyUI prompt

        prompt = prompt.strip()
        prompt = re.sub(r",(\w)", r", \1", prompt)  # Add space after commas

        return prompt, parameters.get('loras', {})

    except Exception as e:
        if verbose:
            print(f"Failed to extract metadata from {file_path}: {e}")
        return None, None


def get_specific_metadata(metadata: dict, option: MetadataOption):
    if option.value in metadata:
        return str(metadata.get(option.value, '')).strip()

    if option == MetadataOption.ALL:
        prompt = metadata.get('full_prompt')
        if not prompt:
            prompt = format_comfy_parameters(metadata)
        return prompt.strip()

    if option == MetadataOption.PROMPT:
        parts = []
        pos = metadata.get('positive')
        if pos:
            parts.append(str(pos).strip())
        neg = metadata.get('negative')
        if neg:
            parts.append(f"Negative prompt: {str(neg).strip()}")
        return "\n".join(parts)

    if option == MetadataOption.PARAMETERS:
        params = []
        keys_to_check = [
            ('steps', 'Steps'), ('sampler', 'Sampler'), ('scheduler', 'Scheduler'),
            ('cfg', 'CFG scale'), ('seed', 'Seed'), ('size', 'Size'), ('model', 'Model')
        ]
        for dict_key, label in keys_to_check:
            val = metadata.get(dict_key)
            if val:
                if dict_key in ['sampler', 'scheduler']:
                    val = str(val).split("/")[-1].capitalize()
                params.append(f"{label}: {val}")

        return ", ".join(params)

    return ""

def get_datalist(
        root_dir: str,
        option: MetadataOption = MetadataOption.POSITIVE_PROMPT,
        process: bool = True,
        amount: Optional[int] = None,
        verbose: bool = False
) -> list:
    """
    Selects a random sample of images and extracts their metadata.

    Args:
        root_dir: Root directory to search for images
        option: Metadata option to extract
            0 - all, 1 - positive prompt, 2 - negative prompt,
            3 - steps, 4 - sampler, 5 - cfg, 6 - size
        process: If true, apply regex clean up for positive or negative prompts
        amount: Amount of images to process, None for all
        verbose: Whether to print verbose information

    Returns:
        List of metadata strings
    """

    data = []
    all_dirs = [dirpath for dirpath, dirnames, filenames in os.walk(root_dir)]

    if amount is None:
        dirs_to_process = all_dirs
    else:
        remaining_dirs = all_dirs.copy()
        dirs_to_process = []

        # Get initial sample of directories to process
        sample_size = min(amount, len(remaining_dirs))
        for _ in range(sample_size):
            if not remaining_dirs:
                break
            idx = random.randint(0, len(remaining_dirs)-1)
            selected_dir = remaining_dirs.pop(idx)
            dirs_to_process.append(selected_dir)

    has_text = option in [MetadataOption.ALL, MetadataOption.PROMPT,
                               MetadataOption.POSITIVE_PROMPT, MetadataOption.NEGATIVE_PROMPT]

    i = 0
    while i < len(dirs_to_process):
        dir_path = dirs_to_process[i]
        successful_in_dir = False

        for file in os.listdir(dir_path):
            try:
                if verbose:
                    print(f"[{i + 1}/{len(dirs_to_process)}] Processing {os.path.join(dir_path, file)}")

                if not file.endswith(VALID_FORMATS) or file.endswith('_thumbnail.png'):
                    continue

                metadata_result = extract_metadata(os.path.join(dir_path, file), verbose=verbose)
                if not metadata_result:
                    continue

                extracted_str = get_specific_metadata(metadata_result, option)
                if not extracted_str:
                    continue

                if has_text and process:
                    extracted_str = process_string(extracted_str)

                if not extracted_str or (data and extracted_str == data[-1]):
                    continue  # Skip empty or duplicate strings

                data.append(extracted_str)
                successful_in_dir = True

                if amount is not None and len(data) >= amount:
                    return data


            except Exception as e:
                if verbose:
                    print(f"Error extracting {file}: {e}")
                continue

        if not successful_in_dir and amount is not None and remaining_dirs:
            # Extracting metadata has failed for an image, try to find another directory that hasn't been used yet
            idx = random.randint(0, len(remaining_dirs)-1)
            new_dir = remaining_dirs.pop(idx)
            dirs_to_process.append(new_dir)
            if verbose:
                print(f"Added new directory {new_dir} to compensate for unsuccessful processing")
        i += 1

    return data


def write_to_file(
        input_root: str,
        output_path: str,
        option: Optional[MetadataOption] = MetadataOption.POSITIVE_PROMPT,
        process: Optional[bool] = True,
        amount: Optional[int] = None,
        verbose: Optional[bool] = False
) -> None:  # maybe add random as option instead of default?
    """
    Extract metadata and write to a textfile

    Args:
        input_root: Root directory to search for images
        output_path: Path to write output to
        option: Metadata option to extract
        process: If true, apply regex cleanup for positive or negative prompts
        amount: Amount of images to process, None for all
        verbose: Whether to print verbose information
    """
    data = get_datalist(input_root, option, process, amount, verbose=verbose)
    with open(output_path, 'w', encoding='utf-8') as file:
        for line in data:
            if line:    # skips empty lines caused by filtering duplicates
                file.write(line + "\n\n")
    print(f"Data written to {output_path}")


def add_metadata_to_json(
        root_dir: str,
        amount: Optional[int] = None,
        offset: Optional[int] = 0,
        overwrite: Optional[bool] = False,
        option: Optional[MetadataOption] = MetadataOption.ALL,
        verbose: Optional[bool] = False,
        add_lora_tags: Optional[bool] = False,
        strip_version: Optional[bool] = False
) -> None:
    """
    Adds parameters of images to Eagle's metadata json file

    Args:
        root_dir: Root directory to search for images
        amount: Amount of images to process, None for all
        offset: Number of images to skip before starting to add metadata
        overwrite: Overwrite existing annotations
        option: Specific metadata option to extract
        verbose: Whether to print verbose information
        add_lora_tags: Whether to add LoRA tags to the JSON
        strip_version: Whether to strip version information from LoRA tags
    """
    processed_count = 0
    skipped_count = 0

    for root, dirs, files in os.walk(root_dir):
        # sort by creation date, from newest to oldest
        dirs.sort(key=lambda d: os.path.getctime(os.path.join(root, d)), reverse=True)

        for file in files:
            if not file.endswith(VALID_FORMATS) or file.endswith('_thumbnail.png'):
                continue

            if skipped_count < offset:
                skipped_count += 1
                continue

            json_path = os.path.join(root, 'metadata.json')
            file_path = os.path.join(root, file)
            update_json = False

            try:
                try:
                    with open(json_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                except UnicodeDecodeError:
                    # If utf-8 fails, try utf-8-sig
                    try:
                        with open(json_path, 'r', encoding='utf-8-sig') as f:
                            data = json.load(f)
                    except UnicodeDecodeError:
                        # try latin-1
                        with open(json_path, 'r', encoding='latin-1') as f:
                            data = json.load(f)

                needs_annotation = overwrite or not data.get('annotation')      # overwrite mode or empty annotation
                if needs_annotation or add_lora_tags:
                    # Extract metadata once only if needed
                    prompt, loras = get_formatted_metadata(file_path, verbose=verbose)

                    if needs_annotation:
                        if prompt:
                            data['annotation'] = prompt
                            update_json = True

                    if add_lora_tags and loras:
                        new_lora_tags = add_loras_as_tags(loras, strip_version=strip_version)

                        if new_lora_tags:
                            existing_tags = data.get('tags', [])
                            existing_tags_set = set(existing_tags)
                            added_tags = False

                            for tag in new_lora_tags:
                                if tag not in existing_tags_set:
                                    existing_tags.append(tag)
                                    existing_tags_set.add(tag)
                                    added_tags = True

                            if added_tags:
                                data['tags'] = existing_tags
                                update_json = True

                if update_json:
                    with open(json_path, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)

            except FileNotFoundError:
                if verbose:
                    print("No metadata file found")
                continue
            except UnicodeDecodeError:
                if verbose:
                    print(f"Error decoding file {file}")
                continue
            except PermissionError:
                if verbose:
                    print(f"Error: Permission denied for {json_path}.")
                continue

            processed_count += 1

            if amount is not None:
                print_percent = max(int(amount * 0.1), 1)  # Print progress every 10%
                if processed_count % print_percent == 0:
                    print(f"Processed {processed_count}/{amount} images")
            else:
                if processed_count % 100 == 0:
                    print(f"Processed {processed_count} images")

            if amount is not None and processed_count >= amount:
                return


def handle_api_command(bulk_path: str = None, strip_version: bool = False):
    if bulk_path and os.path.exists(bulk_path):
        with open(bulk_path, 'r', encoding='utf-8') as f:
            items_to_process = json.load(f)  # Expected format: {"id": "folder_path"}

        results = {}
        for item_id, folder_path in items_to_process.items():
            file_to_process = folder_path

            if os.path.isdir(folder_path):
                for file in os.listdir(folder_path):
                    if file.endswith(VALID_FORMATS) and not file.endswith('_thumbnail.png'):
                        file_to_process = os.path.join(folder_path, file)
                        break

            prompt, loras = get_formatted_metadata(file_path=file_to_process, verbose=False)
            results[item_id] = {
                "annotation": prompt,
                "tags": add_loras_as_tags(loras, strip_version=strip_version) if loras else []
            }

        print(json.dumps(results))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Metadata Extractor")

    subparsers = parser.add_subparsers(dest="mode", required=True, help="Choose extraction mode")

    eagle_parser = subparsers.add_parser("eagle", aliases=['e'], help="Write to Eagle JSON")
    eagle_parser.add_argument("--dir", type=str, required=True, help="Path to process (root library or single .info folder)")
    eagle_parser.add_argument("--amount", "-a", type=int, default=None, help="Amount of images to process. Keep empty for all")
    eagle_parser.add_argument("--offset", "-o", type=int, default=0, help="Number of images to skip before starting to add metadata")
    eagle_parser.add_argument("--overwrite", action="store_true", help="Overwrite existing annotations")
    eagle_parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    eagle_parser.add_argument("--add_lora_tags", action="store_true", help="Add LoRAs as tags")
    eagle_parser.add_argument("--strip_version", action="store_true", help="Strip version info from LoRA tags")

    api_parser = subparsers.add_parser("api", aliases=['a'], help="API mode: Extract metadata from a single file")
    api_parser.add_argument("--bulk", "-b", type=str, help="Path to a JSON file containing items to process")
    api_parser.add_argument("--strip_version", action="store_true", help="Strip version info from LoRA tags")

    file_parser = subparsers.add_parser("file", aliases=['f'], help="Write to Text File")
    file_parser.add_argument("--dir", type=str, required=True, help="Path to process")
    file_parser.add_argument("--out", "-o", type=str, required=True, help="Output path")
    file_parser.add_argument("--option", type=str, default="ALL", choices=[e.name for e in MetadataOption],
                             help="Choose what to extract (e.g. ALL, POSITIVE_PROMPT)")
    file_parser.add_argument("--process", "-p", action="store_true", help="String cleanup for positive and negative prompts")
    file_parser.add_argument("--amount", "-a", type=int, default=None, help="Amount of images to add. Keep empty for all")
    file_parser.add_argument("-v", "--verbose", action="store_true", help="Verbose output")

    args = parser.parse_args()

    if args.mode in ['eagle', 'e']:
        add_metadata_to_json(
            root_dir=args.dir,
            amount=args.amount,
            offset=args.offset,
            overwrite=args.overwrite,
            verbose=args.verbose,
            add_lora_tags=args.add_lora_tags,
            strip_version=args.strip_version
        )
    elif args.mode in ['file', 'f']:
        write_to_file(
            input_root=args.dir,
            output_path=args.out,
            option=MetadataOption[args.option],
            process=args.process,
            amount=args.amount,
            verbose=args.verbose,
        )
    elif args.mode in ['api', 'a']:
        handle_api_command(
            bulk_path=args.bulk,
            strip_version=args.strip_version,
        )
