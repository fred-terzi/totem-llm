import { useState, useEffect } from "react";
import System from "@/models/system";

export default function VeniceLLMOptions({ settings }) {
  const [inputValue, setInputValue] = useState(settings?.VeniceApiKey);
  const [apiKey, setApiKey] = useState(settings?.VeniceApiKey);

  return (
    <div className="flex gap-[36px] mt-1.5">
      <div className="flex flex-col w-60">
        <label className="text-white text-sm font-semibold block mb-3">
          Venice API Key
        </label>
        <input
          type="password"
          name="VeniceApiKey"
          className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
          placeholder="Venice API Key"
          defaultValue={settings?.VeniceApiKey ? "*".repeat(20) : ""}
          required={true}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => setApiKey(inputValue)}
        />
      </div>

      {!settings?.credentialsOnly && (
        <VeniceModelSelection settings={settings} apiKey={apiKey} />
      )}
    </div>
  );
}

/**
 * Venice model selection component.
 * @param {Object} props - The component props
 * @param {string} props.apiKey - The Venice API key (not used for the public model list)
 * @param {Object} props.settings - The system settings
 * @returns {JSX.Element} The Venice model selection component
 */
function VeniceModelSelection({ apiKey: _apiKey, settings }) {
  const [customModels, setCustomModels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function findCustomModels() {
      try {
        setLoading(true);
        const { models } = await System.customModels("venice");
        setCustomModels(models || []);
      } catch (error) {
        console.error("Failed to fetch custom models:", error);
        setCustomModels([]);
      } finally {
        setLoading(false);
      }
    }
    findCustomModels();
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col w-60">
        <label className="text-white text-sm font-semibold block mb-3">
          Chat Model Selection
        </label>
        <select
          name="VeniceModelPref"
          disabled={true}
          className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
        >
          <option disabled={true} selected={true}>
            --loading available models--
          </option>
        </select>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-60">
      <label className="text-white text-sm font-semibold block mb-3">
        Chat Model Selection
      </label>
      <select
        name="VeniceModelPref"
        required={true}
        className="border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5"
      >
        {customModels.length > 0 && (
          <optgroup label="Available models">
            {customModels.map((model) => {
              return (
                <option
                  key={model.id}
                  value={model.id}
                  selected={settings?.VeniceModelPref === model.id}
                >
                  {model.name}
                </option>
              );
            })}
          </optgroup>
        )}
      </select>
    </div>
  );
}
