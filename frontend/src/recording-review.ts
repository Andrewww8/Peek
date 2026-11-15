import { Alert } from 'react-native';

import { recognizeRecordingShot } from './guest-pose';
import type { FootageDecision } from './recordings';

export async function confirmRecordingFootage(uri: string): Promise<FootageDecision> {
  if (await recognizeRecordingShot(uri) === 'recognized') return 'save';

  return new Promise<FootageDecision>((resolve) => {
    Alert.alert('Are you sure this is the right footage?', 'Confirm that this video shows your basketball shot.', [
      { text: 'No, discard', style: 'cancel', onPress: () => resolve('discard') },
      { text: 'Yes, save', onPress: () => resolve('save') },
    ], { cancelable: true, onDismiss: () => resolve('discard') });
  });
}
