import React, { useState } from 'react';
import { useDatabase } from '../contexts/DatabaseContext';

const DatabaseDebug: React.FC = () => {
  const { wardrobeItems, addWardrobeItem } = useDatabase();
  const [testResult, setTestResult] = useState<string>('');
  const [isTesting, setIsTesting] = useState(false);

  const testDatabase = async () => {
    setIsTesting(true);
    setTestResult('Testing database...');

    try {
      // Test adding a simple item
      const testItem = {
        name: 'Test Item',
        category: 'Tops',
        description: 'Test description',
        originalImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', // 1x1 transparent PNG
        packshotImage: undefined
      };

      const id = await addWardrobeItem(testItem);
      setTestResult(`✅ Database test successful! Added item with ID: ${id}`);
      
      // Clean up test item after 3 seconds
      setTimeout(() => {
        // Note: We don't have deleteWardrobeItem in the context, so we'll just note this
        console.log('Test item added successfully, should be cleaned up manually');
      }, 3000);
      
    } catch (error) {
      setTestResult(`❌ Database test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="p-4 bg-gray-100 rounded-lg mb-4">
      <h3 className="text-lg font-semibold mb-2">Database Debug</h3>
      <div className="space-y-2">
        <p><strong>Items in wardrobe:</strong> {wardrobeItems?.length || 0}</p>
        <button
          onClick={testDatabase}
          disabled={isTesting}
          className="px-4 py-2 bg-green-500 text-white rounded disabled:bg-gray-300"
        >
          {isTesting ? 'Testing...' : 'Test Database'}
        </button>
        {testResult && (
          <p className="mt-2 p-2 bg-white rounded border">
            <strong>Test Result:</strong> {testResult}
          </p>
        )}
      </div>
    </div>
  );
};

export default DatabaseDebug;

