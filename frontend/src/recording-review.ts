import { Alert } from 'react-native';

import { recognizeRecordingShot } from './guest-pose';

export async function confirmRecordingFootage(uri: string): Promise<boolean> {
  if (await recognizeRecordingShot(uri) === 'recognized') return true;

  return new Promise<boolean>((resolve) => {
    Alert.alert('Are you sure this is the right footage?', 'Confirm that this video shows your basketball shot.', [
      { text: 'No, discard', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Yes, save', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
