import { requireOptionalNativeModule } from "expo-modules-core";

export type PhotoPickerResult = {
  assetIds: string[];
  dismissalMs: number;
};

type FastPhotoPickerModule = {
  pickPhotos(limit: number): Promise<PhotoPickerResult>;
};

export default requireOptionalNativeModule<FastPhotoPickerModule>(
  "FastPhotoPicker",
);
