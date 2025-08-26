import React, { useState } from 'react';
import { testApiKey } from '../services/openai';
import { useApiKeyContext } from '../contexts/ApiKeyContext';

const ApiKeyDebug: React.FC = () => {
  const { apiKey } = useApiKeyContext();
  const [testResult, setTestResult] = useState<string>('');
  const [isTesting, setIsTesting] = useState(false);

  const testConnection = async () => {
    if (!apiKey) {
      setTestResult('No API key configured');
      return;
    }

    setIsTesting(true);
    setTestResult('Testing...');

    try {
      const isValid = await testApiKey(apiKey);
      if (isValid) {
        setTestResult('✅ API key is valid and connection successful');
      } else {
        setTestResult('❌ API key is invalid or connection failed');
      }
    } catch (error) {
      setTestResult(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="p-4 bg-gray-100 rounded-lg mb-4">
      <h3 className="text-lg font-semibold mb-2">API Key Debug</h3>
      <div className="space-y-2">
        <p><strong>API Key Status:</strong> {apiKey ? '✅ Configured' : '❌ Not configured'}</p>
        <p><strong>API Key Length:</strong> {apiKey?.length || 0} characters</p>
        <button
          onClick={testConnection}
          disabled={isTesting || !apiKey}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
        >
          {isTesting ? 'Testing...' : 'Test API Connection'}
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

export default ApiKeyDebug;

