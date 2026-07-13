/**
 * Validate the contract testkit against the REFERENCE vocabulary: dhaba (untouched, D78) must pass
 * the whole generic suite. If a testkit assertion is wrong, it fails here against known-good code —
 * not against a new theme where the blame would be ambiguous.
 */

import { dhabaVocabulary } from "../dhaba/index";
import { describeVocabularyContract } from "./contract.testkit";

describeVocabularyContract(dhabaVocabulary);
