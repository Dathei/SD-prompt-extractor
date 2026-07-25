import { describe, expect, test } from 'vitest';
import metadataParser from '../js/metadata_parser.js';

const { addLorasAsTags } = metadataParser;

describe('addLorasAsTags with stripVersion', () => {
    test.each([
        ["example_model_v1", "example_model"],
        ["example-model-v1", "example-model"],
        ["example-model_v1", "example-model"],
        ["example_model-v1", "example_model"],
        ["example_model-v1.2", "example_model"],
        ["example_model-epoch_35", "example_model"],
        ["example_model-epoch30", "example_model"],
        ["example_model-ep30", "example_model"],
        ["example_model-epoch-322", "example_model"],
        ["example_model-0001000", "example_model"],
        ["example_model_0123", "example_model"],
        ["example_model_0123_v1.2", "example_model"],
        ["another_example_model-v2.0", "another_example_model"],
        ["another_example_v2_model", "another_example_model"],
        ["another-example-v2.0_model", "another-example_model"],
        ["another-0020020-example-v2.45-model", "another-example-model"],
        ["another_0020020_example_v2.45_model", "another_example_model"],
        // Some existing Krea2 examples
        ["realism_engine_krea2_v3.1", "realism_engine_krea2"],
        ["KNP_000003000", "KNP"],
        ["Krea2-realism-V2", "Krea2-realism"],
        ["krea2_identity_edit_v1_2", "krea2_identity_edit"],
        ["Krea_2_test_82_rank_128-0000001000", "Krea_2_test_82_rank_128"],
        ["test-krea-turbo_000001500", "test-krea-turbo"],
        ["SummerVibesHM_krea2_epoch8", "SummerVibesHM_krea2"],
        ["mmwvhsv2", "mmwvhs"],
        ["hina_krea2Turbo_lora_tqd_v3.0", "hina_krea2Turbo_lora_tqd"],
        ["krea2-masterpieces-v51", "krea2-masterpieces"],
        ["test_v2_loraholic", "test_loraholic"],
        ["RealismSlider-v1", "RealismSlider"],
        ["Tifa-L-800_000003200", "Tifa-L-800"],
        ["UINQ_epoch_4", "UINQ"],
        ["krea2_rt_v1.1_epoch_8", "krea2_rt"],
        ["Age_Slider_krea2t_000000020", "Age_Slider_krea2t"],
        ["retrovintagephotoKrea2_c1-st4000", "retrovintagephotoKrea2_c1"],
        ["VALEJO_KREA2_NEW_epoch_20", "VALEJO_KREA2_NEW"],
        ["Sungmooheo_krea2_c1-st5000", "Sungmooheo_krea2_c1"],
        ["StellarBladeEve-800_000003000", "StellarBladeEve-800"],
        ["K2_Anime_Flat_V20_nnegret", "K2_Anime_Flat_nnegret"],
        ["krea2 edit Anime to Real_000001500", "krea2 edit Anime to Real"],
        // Should stay untouched
        ["lenovo_krea2", "lenovo_krea2"],
        ["RealisticSnapshotKrea2", "RealisticSnapshotKrea2"],
        ["bloomgirls-ultrarealism-krea2_4k", "bloomgirls-ultrarealism-krea2_4k"],
        ["phone_photography_2025_krea2", "phone_photography_2025_krea2"],
        ["cyberpunk_2077", "cyberpunk_2077"],
    ])('%s -> %s', (input, expected) => {
        expect(addLorasAsTags({ [input]: 1.0 }, true)).toEqual([`lora: ${expected}`]);
    });

    test('leaves names untouched when stripVersion is false', () => {
        expect(addLorasAsTags({ "example_model_v1": 1.0 }, false)).toEqual(["lora: example_model_v1"]);
    });
});