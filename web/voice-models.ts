import { gigabytes } from "../shared/voice-engine.ts";
import { fitsMemory, memoryGb, memoryNeededGb, type ChoosableModel } from "../shared/voice-engine-models.ts";

export const modelWithQuality = ({ name, quality }: ChoosableModel) => (quality ? `${name} · ${quality}` : name);

/** How good the model is and what it downloads, or, when this Mac has too little memory for it, how much a Mac needs. */
export const modelChoice = (model: ChoosableModel, memoryBytes: number) =>
  `${modelWithQuality(model)} · ${fitsMemory(model, memoryBytes) ? gigabytes(model.bytes) : `needs a Mac with ${memoryNeededGb(model)} GB of memory`}`;

export const tooLittleMemoryForVoiceModel = (memoryBytes: number) =>
  `This Mac's ${memoryGb(memoryBytes)} GB of memory is too little for a voice model of its own. A profile's API or a server of your own can translate, set below.`;
