import { requireOptionalNativeModule } from "expo-modules-core";

export type PhotoPickerResult = {
  assetIds: string[];
  dismissalMs: number;
};

export type PhotoPreparationResult = {
  requestedCount: number;
  preparedCount: number;
  failedCount: number;
  totalMs: number;
  sourceBytes: number;
  outputBytes: number;
};

type FastPhotoPickerModule = {
  pickPhotos(limit: number): Promise<PhotoPickerResult>;
  pickPhotosWithSystemPicker(limit: number): Promise<PhotoPickerResult>;
  preparePhotos(
    assetIds: string[],
    maxWidth: number,
    jpegQuality: number,
  ): Promise<PhotoPreparationResult>;
};

export default requireOptionalNativeModule<FastPhotoPickerModule>(
  "FastPhotoPicker",
);
