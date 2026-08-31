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

export type PhotoUploadResult = {
  requestedCount: number;
  uploadedCount: number;
  failedCount: number;
  preparationMs: number;
  uploadMs: number;
  totalMs: number;
  uploadedBytes: number;
  firstError: string;
  failedIndexes: number[];
  automaticRetryCount: number;
};

type FastPhotoPickerModule = {
  pickPhotos(limit: number): Promise<PhotoPickerResult>;
  pickPhotosWithSystemPicker(limit: number): Promise<PhotoPickerResult>;
  preparePhotos(
    assetIds: string[],
    maxWidth: number,
    jpegQuality: number,
  ): Promise<PhotoPreparationResult>;
  prepareAndUploadPhotos(
    assetIds: string[],
    uploadUrls: string[],
    maxWidth: number,
    jpegQuality: number,
    simulationMode: "none" | "manual-retry",
  ): Promise<PhotoUploadResult>;
};

export default requireOptionalNativeModule<FastPhotoPickerModule>(
  "FastPhotoPicker",
);
